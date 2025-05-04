// index.js – backend entry point
// -----------------------------------------------------------------------------
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
const { Parser } = require('json2csv');
const { Pool }   = require('pg');

const app  = express();
const port = process.env.PORT || 5000;

// ── 0) Force no‑store on all /api routes ───────────────────────────────────
app.disable('etag');
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
});

// ── 1) ML service URL (only /predict exists) ───────────────────────────────
if (!process.env.ML_API_URL) {
  console.error('ERROR: ML_API_URL must be set in .env');
  process.exit(1);
}
let ML = process.env.ML_API_URL;
if (!/^https?:\/\//i.test(ML)) {
  ML = 'https://' + ML.replace(/^\/+/, '');
}
console.log(`🔍 ML_API_URL = ${ML}`);

// create an ML client for hitting FastAPI /predict
const mlClient = axios.create({
  baseURL: ML,
  httpsAgent: new https.Agent({ keepAlive: false }),
  timeout: 15000
});

// ── 2) Postgres pool for login logs ────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pool.query(`
  CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    username TEXT,
    timestamp TEXT,
    ip TEXT
  )
`).catch(e => console.error('DB init error:', e.message));

// ── 3) Middleware ─────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(morgan('dev'));

// ── 4) Load candidates (bias_data.json) ───────────────────────────────────
const rawIndividuals = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'bias_data.json'), 'utf8')
);
const individuals = rawIndividuals
  .map((c, i) => {
    // normalize origin → country
    const country = (c.origin || c.Origin || c.country || '').trim();
    if (!country) console.warn(`⚠️ record ${i} missing country`, c);
    return { ...c, country };
  })
  .filter(c => c.country);
console.log(`✅ Loaded ${individuals.length} candidates`);

// ── 5) Load country stats ─────────────────────────────────────────────────
const countryStats = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'country_stats.json'), 'utf8')
);

// ── 6) Dashboard endpoints ────────────────────────────────────────────────
// a) All individuals
app.get('/api/individuals', (_, res) => {
  res.json(individuals);
});

// b) Summary
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

// c) Country list
app.get('/api/countries', (_, res) => {
  const list = Object.keys(countryStats)
    .map(n => n[0].toUpperCase() + n.slice(1))
    .sort();
  res.json(list);
});

// d) Country stats
app.get('/api/country-stats/:country', (req, res) => {
  const stats = countryStats[req.params.country.toLowerCase()];
  if (!stats) return res.status(404).json({ error: 'country not found' });
  res.json(stats);
});

// ── 7) Login & logs ────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (username.toLowerCase() !== 'admin' || password !== 'adminpass') {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const timestamp = new Date().toISOString();
  try {
    await pool.query(
      'INSERT INTO logs(username,timestamp,ip) VALUES($1,$2,$3)',
      [username, timestamp, req.ip]
    );
    res.json({ status: 'success', user: username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login save failed' });
  }
});

app.get('/api/logs', async (_, res) => {
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

// ── 8) CSV export ─────────────────────────────────────────────────────────
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

// ── 9) Single-record ML proxy (Simulate page) ─────────────────────────────
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

// ── 10) Batch bias‑fixer (Playground) ──────────────────────────────────────
app.post('/api/bias-fixer', async (req, res) => {
  const { minScore, tolerance } = req.body;
  if (minScore == null || tolerance == null) {
    return res.status(400).json({ error: 'missing parameters' });
  }
  console.log('→ /api/bias-fixer payload:', req.body);

  // mapping helpers
  const educationMap = {
    'High School': 1,
    Bachelors:     2,
    Masters:       3,
    PhD:           4
  };
  const ageGroup = yrs => (yrs < 2 ? 1 : yrs < 5 ? 2 : yrs < 10 ? 3 : 4);

  try {
    const results = await Promise.all(individuals.map(async person => {
      // get country stats for payload
      const stats = countryStats[ person.country.toLowerCase() ] || {};

      // build the ML payload exactly like /predict needs
      const payload = {
        age_group:              ageGroup(person.years_experience),
        education_level:        educationMap[person.education] || 1,
        professional_developer: 1,
        years_code:             person.years_experience,
        pct_female_highered:    stats.Pct_Female_HigherEd,
        pct_male_highered:      stats.Pct_Male_HigherEd,
        pct_female_mided:       stats.Pct_Female_MidEd,
        pct_male_mided:         stats.Pct_Male_MidEd,
        pct_female_lowed:       stats.Pct_Female_LowEd,
        pct_male_lowed:         stats.Pct_Male_LowEd
      };

      // call your FastAPI /predict
      const { data } = await mlClient.post('/predict', payload);
      const origPct = Math.round(data.qualification_score * 100);

      // bump for bias flags
      const bumpCount = (person.bias_flags || [])
        .filter(f => f === 'gender' || f === 'migrant')
        .length;
      const adjusted = origPct + tolerance * 5 * bumpCount;

      return {
        name:           person.name,
        original_score: origPct,
        adjusted_score: Math.round(adjusted),
        hired:          adjusted >= minScore
      };
    }));

    res.json(results);
  } catch (e) {
    console.error('Bias-fixer error:', e.response?.data || e.message);
    res.status(500).json({ error: 'simulation failed' });
  }
});

// ── 11) Serve React build if present ───────────────────────────────────────
const buildDir = path.join(__dirname, 'build');
if (fs.existsSync(buildDir)) {
  app.use(express.static(buildDir));
  app.get('*', (_, res) =>
    res.sendFile(path.join(buildDir, 'index.html'))
  );
}

// ── 12) Global error handler & start ─────────────────────────────────────
app.use((err, _, res, next) => {
  console.error(err.stack);
  res.status(500).send('something broke!');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend listening on port ${port}`);
});
