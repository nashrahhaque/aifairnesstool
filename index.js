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
const axios      = require('axios').create({
  httpsAgent: new https.Agent({ keepAlive: false }), // avoid stale TLS sockets
  timeout:   15000                                   // 15 s timeout
});
const { Parser } = require('json2csv');
const { Pool }   = require('pg');

const app  = express();
const port = process.env.PORT || 5000;

// ── Disable ETag + force no‑store on all /api routes ────────────────────────
app.disable('etag');
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
});

// ── 0) Read & normalize ML service URL ───────────────────────────────────────
let ML = process.env.ML_API_URL || '';
if (!ML) {
  console.error(
    'ERROR: process.env.ML_API_URL must be set ' +
    '(e.g. https://your-ml-backend.onrender.com)'
  );
  process.exit(1);
}
if (!/^https?:\/\//i.test(ML)) {
  ML = 'https://' + ML.replace(/^\/+/, '');
}
console.log(`🔍 Backend startup: ML_API_URL = ${ML}`);

// ── 1) PostgreSQL Pool Setup ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:              { rejectUnauthorized: false }
});
pool.query(`
  CREATE TABLE IF NOT EXISTS logs (
    id        SERIAL PRIMARY KEY,
    username  TEXT,
    timestamp TEXT,
    ip        TEXT
  )
`).catch(err => console.error('⚠️  DB init error:', err.message));

// ── 2) Global Middlewares ───────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(morgan('dev'));

// ── 3) Load & normalize individuals (dashboard data) ────────────────────────
const rawIndividuals = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'bias_data.json'), 'utf8')
);
const individuals = rawIndividuals
  .map((c, i) => {
    // normalize `origin` (or fallback) into `country`
    const country = (c.origin || c.Origin || c.country || '').trim();
    if (!country) {
      console.warn(`⚠️ record ${i} missing origin/country field`, c);
    }
    return { ...c, country };
  })
  .filter(c => c.country);
console.log(`✅ Loaded ${individuals.length} candidates from bias_data.json`);

// ── 4) Load country stats ────────────────────────────────────────────────────
const countryStats = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'country_stats.json'), 'utf8')
);

// ── 5) Public API endpoints ──────────────────────────────────────────────────
app.get('/api/individuals', (_, res) => {
  res.json(individuals);
});

app.get('/api/summary', (_, res) => {
  const total = individuals.length;
  let totalScore = 0;
  const biasCounts = {};
  individuals.forEach(c => {
    totalScore += c.qualification_score;
    (c.bias_flags || []).forEach(f => {
      const key = f.toLowerCase();
      biasCounts[key] = (biasCounts[key] || 0) + 1;
    });
  });
  res.json({
    totalCandidates: total,
    averageQualificationScore: total ? totalScore / total : 0,
    biasDistribution: biasCounts
  });
});

app.get('/api/countries', (_, res) => {
  const list = Object.keys(countryStats)
    .map(n => n.charAt(0).toUpperCase() + n.slice(1))
    .sort();
  res.json(list);
});

app.get('/api/country-stats/:country', (req, res) => {
  const one = countryStats[req.params.country.toLowerCase()];
  if (!one) return res.status(404).json({ error: 'country not found' });
  res.json(one);
});

// ── 6) Login & logs ─────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (username.toLowerCase() !== 'admin' || password !== 'adminpass') {
    return res.status(401).json({ error: 'invalid username or password' });
  }
  const timestamp = new Date().toISOString();
  try {
    await pool.query(
      'INSERT INTO logs (username, timestamp, ip) VALUES ($1,$2,$3)',
      [username, timestamp, req.ip]
    );
    res.json({ status: 'success', user: username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save login' });
  }
});

app.get('/api/logs', async (_, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM logs ORDER BY timestamp DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ── 7) Export CSV ────────────────────────────────────────────────────────────
app.get('/api/export', (_, res) => {
  try {
    const parser = new Parser();
    const csv    = parser.parse(individuals);
    res
      .header('Content-Type', 'text/csv')
      .attachment('individuals.csv')
      .send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 8) Single-record proxy for simulate page (ML prediction) ────────────────
app.post('/api/predict', async (req, res) => {
  console.log('→ proxy /api/predict payload:', req.body);
  try {
    const { data } = await axios.post(`${ML}/predict`, req.body);
    res.json(data);
  } catch (err) {
    console.error('Proxy predict error:', err.response?.status, err.response?.data || err.message);
    res
      .status(err.response?.status || 500)
      .json({ error: err.response?.data?.detail || err.message });
  }
});

// ── 9) Bias‑fixer batch simulation (playground) ──────────────────────────────
app.post('/api/bias-fixer', async (req, res) => {
  const { minScore, tolerance } = req.body;
  if (minScore == null || tolerance == null) {
    return res.status(400).json({ error: 'missing parameters' });
  }
  console.log('→ /api/bias-fixer got payload:', req.body, `– ${individuals.length} candidates`);

  // mapping helpers
  const educationMap = {
    'High School': 1,
    'Bachelors':   2,
    'Masters':     3,
    'PhD':         4
  };
  function deriveAgeGroup(yearsExp) {
    if (yearsExp < 2) return 1;
    if (yearsExp < 5) return 2;
    if (yearsExp < 10) return 3;
    return 4;
  }

  try {
    const calls = individuals.map(async person => {
      const stats = countryStats[ person.country.toLowerCase() ] || {};

      // build the payload for FastAPI /predict
      const payload = {
        age_group:              deriveAgeGroup(person.years_experience),
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

      // call the ML service
      const { data } = await axios.post(`${ML}/predict`, payload);

      // convert to percentage
      const originalPct = Math.round(data.qualification_score * 100);

      // apply your bias‑fixer bump
      const bumpCount = (person.bias_flags || [])
        .filter(f => ['gender','migrant'].includes(f))
        .length;
      const adjustedPct = originalPct + tolerance * 5 * bumpCount;
      const hired = adjustedPct >= minScore;

      return {
        name:           person.name,
        original_score: originalPct,
        adjusted_score: Math.round(adjustedPct),
        hired
      };
    });

    const results = await Promise.all(calls);
    res.json(results);

  } catch (err) {
    console.error('ML Bias Fixer error:', err.response?.data || err.message);
    res.status(500).json({ error: 'failed to simulate bias adjustment' });
  }
});

// ── 10) Serve React build if present ─────────────────────────────────────────
const buildPath = path.join(__dirname, 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (_, res) =>
    res.sendFile(path.join(buildPath, 'index.html'))
  );
}

// ── 11) Global error handler & start ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('something broke!');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${port}`);
});
