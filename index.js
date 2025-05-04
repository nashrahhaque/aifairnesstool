require('dotenv').config()
const express    = require('express')
const cors       = require('cors')
const bodyParser = require('body-parser')
const morgan     = require('morgan')
const fs         = require('fs')
const path       = require('path')
const axios      = require('axios')
const { Parser } = require('json2csv')
const { Pool }   = require('pg')

const app  = express()
const port = process.env.PORT || 5000

// ── 0) Read ML service URL from env ────────────────────────────────────────────
const ML = process.env.ML_API_URL
if (!ML) {
  console.error('ERROR: process.env.ML_API_URL must be set (e.g. https://your-ml-backend.onrender.com)')
  process.exit(1)
}

// ── 1) PostgreSQL Pool Setup ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})
pool.query(`
  CREATE TABLE IF NOT EXISTS logs (
    id        SERIAL PRIMARY KEY,
    username  TEXT,
    timestamp TEXT,
    ip        TEXT
  )
`)

// ── 2) Middlewares ────────────────────────────────────────────────────────────
app.use(cors())
app.use(bodyParser.json())
app.use(morgan('dev'))

// ── 3) Load candidate + country data ─────────────────────────────────────────
const individuals = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'bias_data.json'), 'utf8')
)
const countryStats = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'country_stats.json'), 'utf8')
)

// ── 4) Public API endpoints ───────────────────────────────────────────────────

// GET /api/individuals
app.get('/api/individuals', (req, res) => {
  res.json(individuals)
})

// GET /api/summary
app.get('/api/summary', (req, res) => {
  const total = individuals.length
  let totalScore = 0, biasCounts = {}
  individuals.forEach(c => {
    totalScore += c.qualification_score
    c.bias_flags.forEach(f => {
      const key = f.toLowerCase()
      biasCounts[key] = (biasCounts[key] || 0) + 1
    })
  })
  res.json({
    totalCandidates: total,
    averageQualificationScore: total ? totalScore / total : 0,
    biasDistribution: biasCounts
  })
})

// GET /api/countries
app.get('/api/countries', (req, res) => {
  res.json(Object.keys(countryStats).sort())
})

// GET /api/country-stats/:country
app.get('/api/country-stats/:country', (req, res) => {
  const one = countryStats[req.params.country]
  if (!one) return res.status(404).json({ error: 'country not found' })
  res.json(one)
})

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' })
  if (username.toLowerCase() !== 'admin' || password !== 'adminpass') {
    return res.status(401).json({ error: 'invalid username or password' })
  }
  const timestamp = new Date().toISOString(), ip = req.ip
  try {
    await pool.query(
      'INSERT INTO logs (username, timestamp, ip) VALUES ($1,$2,$3)',
      [username, timestamp, ip]
    )
    res.json({ status: 'success', user: username })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to save login' })
  }
})

// GET /api/logs
app.get('/api/logs', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM logs ORDER BY timestamp DESC')
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch logs' })
  }
})

// GET /api/export
app.get('/api/export', (req, res) => {
  try {
    const parser = new Parser()
    const csv    = parser.parse(individuals)
    res.header('Content-Type', 'text/csv')
       .attachment('individuals.csv')
       .send(csv)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── 5) Bias‑fixer simulation (calls your ML service) ───────────────────────────
app.post('/api/bias-fixer', async (req, res) => {
  const { minScore, tolerance } = req.body
  if (minScore == null || tolerance == null) {
    return res.status(400).json({ error: 'missing parameters' })
  }

  try {
    const calls = individuals.map(async c => {
      const stats = countryStats[c.country] || {}
      const payload = {
        age_group:             c.age_group,
        education_level:       c.education_level,
        professional_developer: c.professional_developer,
        years_code:            c.years_code,
        pct_female_highered:   stats.pct_female_highered,
        pct_male_highered:     stats.pct_male_highered,
        pct_female_mided:      stats.pct_female_mided,
        pct_male_mided:        stats.pct_male_mided,
        pct_female_lowed:      stats.pct_female_lowed,
        pct_male_lowed:        stats.pct_male_lowed
      }

      // hit your FastAPI ML endpoint
      const mlRes = await axios.post(`${ML}/predict`, payload)
      const score = mlRes.data.qualification_score

      return {
        name:           c.name,
        original_score: c.qualification_score,
        adjusted_score: score + tolerance * 5 * (
          c.bias_flags.includes('gender') + c.bias_flags.includes('migrant')
        ),
        hired: score >= minScore
      }
    })

    const results = await Promise.all(calls)
    res.json(results)

  } catch (err) {
    console.error('ML Bias Fixer error:', err.message)
    res.status(500).json({ error: 'failed to simulate bias adjustment' })
  }
})

// ── 6) Serve React build ─────────────────────────────────────────────────────
const buildPath = path.join(__dirname, 'build')
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath))
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'))
  })
}

// ── 7) Global error handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).send('something broke!')
})

// ── 8) Start server ──────────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
  console.log(`Backend server running on port ${port}, ML_API_URL=${ML}`)
})
