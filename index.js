// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 5000;

// PostgreSQL Pool Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create logs table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    username TEXT,
    timestamp TEXT,
    ip TEXT
  )
`);

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(morgan('dev'));

// Load candidate data from bias_data.json
const individuals = JSON.parse(fs.readFileSync(path.join(__dirname, 'bias_data.json'), 'utf8'));

// Endpoint: Get all candidate data
app.get('/api/individuals', (req, res) => {
  res.json(individuals);
});

// Aggregated summary endpoint
app.get('/api/summary', (req, res) => {
  const total = individuals.length;
  let totalScore = 0;
  const biasCounts = {};

  individuals.forEach(candidate => {
    totalScore += candidate.qualification_score;
    candidate.bias_flags.forEach(flag => {
      const normFlag = flag.toLowerCase();
      biasCounts[normFlag] = (biasCounts[normFlag] || 0) + 1;
    });
  });

  const averageScore = total ? (totalScore / total) : 0;

  res.json({
    totalCandidates: total,
    averageQualificationScore: averageScore,
    biasDistribution: biasCounts
  });
});

// Login endpoint with PostgreSQL logging
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const validUsername = 'admin';
  const validPassword = 'adminpass';

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  if (username.toLowerCase() !== validUsername || password !== validPassword) {
    return res.status(401).json({ error: "invalid username or password" });
  }

  const timestamp = new Date().toISOString();
  const ip = req.ip;

  try {
    await pool.query(
      'INSERT INTO logs (username, timestamp, ip) VALUES ($1, $2, $3)',
      [username, timestamp, ip]
    );
    console.log(`✅ Logged in: ${username}`);
    res.json({ status: 'success', user: username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save login" });
  }
});

// Endpoint: Get login logs
app.get('/api/logs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM logs ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// Endpoint: Export candidate data as CSV
app.get('/api/export', (req, res) => {
  try {
    const parser = new Parser();
    const csv = parser.parse(individuals);
    res.header('Content-Type', 'text/csv');
    res.attachment('individuals.csv');
    return res.send(csv);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// New: Simulate AI hiring experience
app.post('/api/simulate-hiring', (req, res) => {
  const { name, gender, origin, education, years_experience } = req.body;

  if (!name || !gender || !origin || !education || years_experience === undefined) {
    return res.status(400).json({ error: "missing fields" });
  }

  const flags = [];
  let score = 50;

  if (gender.toLowerCase() === 'female') flags.push('gender');
  if (origin.toLowerCase().includes('foreign')) flags.push('migrant');
  if (!education.toLowerCase().includes('bachelor') && !education.toLowerCase().includes('master')) flags.push('non-degree');
  if (parseInt(years_experience) < 3) flags.push('low experience');

  score += parseInt(years_experience) * 5;
  if (education.toLowerCase().includes('phd')) score += 10;

  let decision = 'interview';
  if (score < 50) decision = 'rejected';
  else if (score > 75) decision = 'hired';

  res.json({
    decision,
    bias_flags: flags,
    qualification_score: score,
    name
  });
});

// New: Bias fixer playground simulation
app.post('/api/bias-fixer', (req, res) => {
  const { minScore, tolerance } = req.body;
  if (minScore === undefined || tolerance === undefined) {
    return res.status(400).json({ error: "missing parameters" });
  }

  const simulated = individuals.map(c => {
    let score = c.qualification_score;
    let adjusted = score;
    if (c.bias_flags.includes('gender')) adjusted += tolerance * 5;
    if (c.bias_flags.includes('migrant')) adjusted += tolerance * 5;
    return {
      name: c.name,
      original_score: score,
      adjusted_score: adjusted,
      hired: adjusted >= minScore
    };
  });

  res.json(simulated);
});

// Serve static files from React build
const buildPath = path.join(__dirname, 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('something broke!');
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Backend server running on port ${port}`);
});
