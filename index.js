// index.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');

const app = express();
const port = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(morgan('dev'));

// In-memory storage for login logs (for demo purposes)
let loginLogs = [];

// Load candidate data from bias_data.json
const individuals = JSON.parse(fs.readFileSync(path.join(__dirname, 'bias_data.json'), 'utf8'));

// Endpoint: Get all candidate data
app.get('/api/individuals', (req, res) => {
  res.json(individuals);
});

// Optional: Aggregated summary endpoint for additional insights
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

// Endpoint: Login with hard-coded admin credentials
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  // Hard-coded admin credentials
  const validUsername = 'admin';
  const validPassword = 'adminpass';

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  if (username.toLowerCase() !== validUsername || password !== validPassword) {
    return res.status(401).json({ error: "invalid username or password" });
  }

  // Record the login event (with actual timestamp and IP)
  const logEntry = { username, timestamp: new Date().toISOString(), ip: req.ip };
  loginLogs.push(logEntry);
  console.log(`User ${username} logged in at ${logEntry.timestamp}`);
  res.json({ status: 'success', user: username });
});

// Endpoint: Get login logs (for admin dashboard)
app.get('/api/logs', (req, res) => {
  res.json(loginLogs);
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

// Serve static files from React's production build (if it exists)
// Ensure that your production build folder is correctly located; here we assume it's in ./build
const buildPath = path.join(__dirname, 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  // Catch-all: Serve the React app for any route not matched by an API endpoint.
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// Basic error handling middleware (optional)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('something broke!');
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Backend server running on port ${port}`);
});
