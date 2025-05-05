/*
 * index.js – backend entry point
 * -----------------------------------------------------------
 * • Express + PostgreSQL + express‑session
 * • Secure password hashing with bcrypt
 * • Role‑based auth (admin/user)
 * • ML service proxy  ➜  POST /api/predict
 * • Candidate JSON APIs + CSV export
 * • Login‑IP logging
 */

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

/* ── Imports ─────────────────────────────────────────────── */
const express  = require('express');
const cors     = require('cors');
const bodyParser = require('body-parser');
const morgan   = require('morgan');
const session  = require('express-session');
const pgStore  = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const axios    = require('axios');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { Parser } = require('json2csv');

/* ── Basic app setup ─────────────────────────────────────── */
const app  = express();
const port = process.env.PORT || 5000;

/* ── ML micro‑service url ────────────────────────────────── */
let ML = process.env.ML_API_URL;
if (!ML) {
  console.error('❌  ML_API_URL must be defined in .env'); process.exit(1);
}
if (!/^https?:\/\//i.test(ML)) ML = 'https://' + ML.replace(/^\/+/, '');
console.log('🔗  ML_API_URL =', ML);

const mlClient = axios.create({
  baseURL: ML,
  httpsAgent: new https.Agent({ keepAlive: false }),
  timeout: 15000
});

/* ── Postgres pool ───────────────────────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ── Ensure core tables exist ────────────────────────────── */
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT        NOT NULL,
      role     TEXT        NOT NULL DEFAULT 'user'
    );
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      username  TEXT,
      timestamp TIMESTAMPTZ DEFAULT now(),
      ip        TEXT
    );
  `).catch(e => { console.error('DB init error:', e.message); process.exit(1); });
})();

/* ── Session middleware (Postgres store) ─────────────────── */
app.use(
  session({
    store: new pgStore({
      pool,
      createTableIfMissing: true          // ← auto‑creates the "session" table
    }),
    secret: process.env.SESSION_SECRET || 'super‑secret‑dev‑key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 4          // 4 h
    }
  })
);

/* ── Misc middleware ─────────────────────────────────────── */
app.disable('etag');
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(morgan('dev'));
app.use('/api', (_, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0'); next();
});

/* ── Auth helpers ────────────────────────────────────────── */
const requireAuth  = (req,res,next) =>
  req.session.user ? next() : res.status(401).json({ error:'unauthorized' });
const requireAdmin = (req,res,next) =>
  (req.session.user?.role === 'admin')
    ? next()
    : res.status(403).json({ error:'admin only' });

/* ── Signup / Login / Logout ─────────────────────────────── */
app.post('/api/signup', async (req,res) => {
  const { username='', password='', role='user' } = req.body ?? {};
  if (!username.trim() || !password) {
    return res.status(400).json({ error:'username & password required' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users(username,password,role) VALUES($1,$2,$3)`,
      [ username.trim().toLowerCase(), hash, role ]
    );
    return res.json({ status:'signup success' });
  } catch (e) {
    if (e.code === '23505')               // unique_violation
      return res.status(409).json({ error:'username taken' });
    console.error(e); return res.status(500).json({ error:'signup failed' });
  }
});

app.post('/api/login', async (req,res) => {
  const { username='', password='' } = req.body ?? {};
  if (!username.trim() || !password)
    return res.status(400).json({ error:'username & password required' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE username=$1`,
      [ username.trim().toLowerCase() ]
    );
    const user = rows[0];

    // compare bcrypt hash (fallback to raw match for legacy plaintext rows)
    const ok = user &&
               (await bcrypt.compare(password, user.password) ||
                user.password === password);

    if (!ok) return res.status(401).json({ error:'invalid credentials' });

    req.session.user = { username:user.username, role:user.role };

    await pool.query(
      `INSERT INTO logs(username, ip) VALUES($1,$2)`,
      [ user.username, req.ip ]
    );

    res.json({ status:'login success', user:req.session.user });
  } catch (e) {
    console.error(e); res.status(500).json({ error:'login failed' });
  }
});

app.get('/api/logout', (req,res) => {
  req.session.destroy(() => res.json({ status:'logout success' }));
});

/* ── Load bias demo data ─────────────────────────────────── */
const rawIndividuals = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'bias_data.json'),'utf8')
);
const individuals = rawIndividuals.map((c,i) => ({
  ...c,
  country: (c.origin||c.Origin||c.country||'').trim().toLowerCase()
})).filter(c => c.country);

const countryStats = JSON.parse(
  fs.readFileSync(path.join(__dirname,'country_stats.json'),'utf8')
);
console.log(`✅  Loaded ${individuals.length} candidates`);

/* ── Public APIs ─────────────────────────────────────────── */
app.get('/api/individuals', (_,res) => res.json(individuals));

app.get('/api/summary', (_,res) => {
  const total = individuals.length;
  const avg   = total
    ? individuals.reduce((s,c)=>s+c.qualification_score,0)/total
    : 0;
  const dist  = {};
  individuals.forEach(c =>
    (c.bias_flags||[]).forEach(f => dist[f.toLowerCase()] = (dist[f.toLowerCase()]||0)+1));
  res.json({ totalCandidates:total, averageQualificationScore:avg, biasDistribution:dist });
});

app.get('/api/countries', (_,res) =>
  res.json(Object.keys(countryStats).sort()));

app.get('/api/country-stats/:country', (req,res) => {
  const stats = countryStats[req.params.country.toLowerCase()];
  return stats ? res.json(stats)
               : res.status(404).json({ error:'country not found' });
});

/* ── ML proxy ────────────────────────────────────────────── */
app.post('/api/predict', async (req,res) => {
  try {
    const { data } = await mlClient.post('/predict', req.body);
    res.json(data);
  } catch (e) {
    console.error('Predict proxy error:', e.response?.data || e.message);
    res.status(e.response?.status||500)
       .json({ error:e.response?.data?.detail || e.message });
  }
});

/* ── Admin logs & CSV export ─────────────────────────────── */
app.get('/api/logs', requireAuth, requireAdmin, async (_,res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM logs ORDER BY timestamp DESC');
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error:'failed to fetch logs' }); }
});

app.get('/api/export', (_,res) => {
  try {
    const csv = new Parser().parse(individuals);
    res.header('Content-Type','text/csv')
       .attachment('individuals.csv')
       .send(csv);
  } catch (e) { res.status(500).json({ error:e.message }); }
});

/* ── Serve React build if it exists ──────────────────────── */
const buildDir = path.join(__dirname,'build');
if (fs.existsSync(buildDir)) {
  app.use(express.static(buildDir));
  app.get('*', (_,res) => res.sendFile(path.join(buildDir,'index.html')));
}

/* ── Keep ML dyno awake on Render ────────────────────────── */
if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    mlClient.get('/').catch(()=>{});
  }, 1000*60*30); // every 30 min
}

/* ── Global error handler & start server ─────────────────── */
app.use((err,_,res,__) => {
  console.error(err.stack); res.status(500).send('internal error');
});

app.listen(port,'0.0.0.0', () =>
  console.log(`🚀  Backend listening on http://0.0.0.0:${port}`));
