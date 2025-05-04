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
app.use(cors());
app.use(bodyParser.json());
app.use(morgan('dev'));

// ─────────────────────────────────────────────────────────────
// PostgreSQL: login logs
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
// API Endpoints
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

// ✔️ COUNTRY ENDPOINTS FIXED
app.get('/api/countries', (_, res) => {
  const list = Object.keys(countryStats).sort(); // lowercase values returned
  res.json(list);
});

app.get('/api/country-stats/:country', (req, res) => {
  const stats = countryStats[req.params.country.toLowerCase()];
  if (!stats) return res.status(404).json({ error: 'country not found' });
  res.json(stats);
});

// ✔️ ML PREDICT ENDPOINT (Simulate page)
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

// Login system
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

// ─────────────────────────────────────────────────────────────
// Start
app.use((err, _, res, next) => {
  console.error(err.stack);
  res.status(500).send('something broke!');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend listening on port ${port}`);
});
