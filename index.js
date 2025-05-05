if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const morgan     = require('morgan');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const axios      = require('axios');
const session    = require('express-session');
const { Parser } = require('json2csv');
const { Pool }   = require('pg');

const app  = express();
const port = process.env.PORT || 5000;

// ─────────────────────────────────────────────────────────────
// Disable caching on all /api routes
app.disable('etag');
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
});

// ─────────────────────────────────────────────────────────────
// ML service setup
if (!process.env.ML_API_URL) {
  console.error('ERROR: ML_API_URL must be set in .env');
  process.exit(1);
}
let ML = process.env.ML_API_URL;
if (!/^https?:\/\//i.test(ML)) {
  ML = 'https://' + ML.replace(/^\/+/, '');
}
console.log(`🔍 ML_API_URL = ${ML}`);

const mlClient = axios.create({
  baseURL: ML,
  httpsAgent: new https.Agent({ keepAlive: false }),
  timeout: 15000
});

// ─────────────────────────────────────────────────────────────
// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(morgan('dev'));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'supersecret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // set true if HTTPS
      maxAge: 1000 * 60 * 60 // 1 hour
    }
  })
);

// ─────────────────────────────────────────────────────────────
// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  );
  CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    username TEXT,
    timestamp TEXT,
    ip TEXT
  );
`).catch(e => console.error('DB init error:', e.message));

// ─────────────────────────────────────────────────────────────
// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
};

// ─────────────────────────────────────────────────────────────
// Signup + Login + Logout
app.post('/api/signup', async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'all fields required' });
  }
  try {
    await pool.query(
      'INSERT INTO users(username, password, role) VALUES($1, $2, $3)',
      [username, password, role]
    );
    res.json({ status: 'signup success' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'signup failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (!rows.length) return res.status(401).json({ error: 'invalid credentials' });

    const user = rows[0];
    req.session.user = { username: user.username, role: user.role };

    await pool.query(
      'INSERT INTO logs(username,timestamp,ip) VALUES($1,$2,$3)',
      [username, new Date().toISOString(), req.ip]
    );

    res.json({ status: 'login success', user: req.session.user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login failed' });
  }
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ status: 'logout success' });
  });
});

// ─────────────────────────────────────────────────────────────
// Load JSON data
const rawIndividuals = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'bias_data.json'), 'utf8')
);
const individuals = rawIndividuals.map((c, i) => {
  const country = (c.origin || c.Origin || c.country || '').trim().toLowerCase();
  if (!country) console.warn(`⚠️ record ${i} missing country`, c);
  return { ...c, country };
}).filter(c => c.country);

console.log(`✅ Loaded ${individuals.length} candidates`);

const countryStats = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'country_stats.json'), 'utf8')
);

// ─────────────────────────────────────────────────────────────
// API Endpoints (open)
app.get('/api/individuals', (_, res) => {
  res.json(individuals);
});

app.get('/api/summary', (_, res) => {
  const total = individuals.length;
  let sumScore = 0;
  const dist = {};
  individuals.forEach(c => {
    sumScore += c.qualification_score;
    (c.bias_flags || []).forEach(f => {
      const k = f.toLowerCase();
      dist[k] = (dist[k] || 0) + 1;
    });
  });
  res.json({
    totalCandidates: total,
    averageQualificationScore: total ? sumScore / total : 0,
    biasDistribution: dist
  });
});

app.get('/api/countries', (_, res) => {
  const list = Object.keys(countryStats).sort();
  res.json(list);
});

app.get('/api/country-stats/:country', (req, res) => {
  const stats = countryStats[req.params.country.toLowerCase()];
  if (!stats) return res.status(404).json({ error: 'country not found' });
  res.json(stats);
});

app.post('/api/predict', async (req, res) => {
  console.log('→ /api/predict payload:', req.body);
  try {
    const { data } = await mlClient.post('/predict', req.body);
    res.json(data);
  } catch (e) {
    console.error('Predict proxy error:', e.response?.data || e.message);
    res
      .status(e.response?.status || 500)
      .json({ error: e.response?.data?.detail || e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Admin-only logs
app.get('/api/logs', requireAuth, requireAdmin, async (_, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM logs ORDER BY timestamp DESC'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed to fetch logs' });
  }
});

// CSV Export
app.get('/api/export', (_, res) => {
  try {
    const parser = new Parser();
    res
      .header('Content-Type', 'text/csv')
      .attachment('individuals.csv')
      .send(parser.parse(individuals));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Serve React frontend if build exists
const buildDir = path.join(__dirname, 'build');
if (fs.existsSync(buildDir)) {
  app.use(express.static(buildDir));
  app.get('*', (_, res) =>
    res.sendFile(path.join(buildDir, 'index.html'))
  );
}

if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    console.log('⏰ Pinging ML service to keep it awake...');
    mlClient.get('/')
      .then(() => console.log('✅ ML service is awake'))
      .catch(err => console.warn('⚠️ Failed to ping ML service', err.message));
  }, 1000 * 60 * 30); // every 30 minutes
}


// ─────────────────────────────────────────────────────────────
// Start
app.use((err, _, res, next) => {
  console.error(err.stack);
  res.status(500).send('something broke!');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend listening on port ${port}`);
});
