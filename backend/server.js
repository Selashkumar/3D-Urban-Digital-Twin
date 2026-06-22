// started this project after messing around with the OGC API spec docs for a few days
// the spec itself is at https://ogcapi.ogc.org/features/ - recommend reading parts 1 and 2
// turns out the whole thing is basically a REST wrapper around WFS3, just nicer

const express = require('express')
const http = require('http')
const { WebSocketServer } = require('ws')
const cors = require('cors')
const path = require('path')
const fs = require('fs')

const logger = require('./middleware/logger')

// Database checking is handled asynchronously in startServer()

const app = express()
const server = http.createServer(app)

// TODO: add rate limiting before we put this on the internet
// right now this is dev-only so it's fine, but definitely needed for prod
const corsOptions = {
  origin: (origin, callback) => {
    // allow vite dev server + no-origin requests (postman, curl etc.)
    const allowed = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173']
    if (!origin || allowed.includes(origin)) {
      callback(null, true)
    } else {
      // in prod you'd check against a whitelist - for now just log it
      console.warn('CORS blocked origin:', origin)
      callback(null, true)  // still allowing for now, tighten later
    }
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
}

app.use(cors(corsOptions))
app.use(express.json())
app.use(logger)

// mount all the OGC Feature API endpoints under /api
const ogcRouter = require('./routes/ogc')
app.use('/api', ogcRouter)

// simple health check - the frontend polls this on startup
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() })
})

// 404 fallback - return JSON not HTML
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path })
})

// generic error handler - express needs all 4 params to recognize this as error middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal Server Error', message: err.message })
})

/*
 * WebSocket setup
 * we're using /ws as the upgrade path so we can keep the http server for express
 * and ws for real-time updates. Originally tried socket.io but it felt like overkill
 * for what is essentially a one-way push from server -> clients
 */

// keeping track of who's connected to the websocket
// using a Set instead of array so cleanup is easier (delete is O(1) on Set)
const clients = new Set()

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  clients.add(ws)
  console.log(`WS client connected (${clients.size} total) from ${req.socket.remoteAddress}`)

  // send a hello so the client knows we're ready
  ws.send(JSON.stringify({ type: 'connected', message: 'Urban Twin WS ready' }))

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`WS client disconnected (${clients.size} remaining)`)
  })

  ws.on('error', (err) => {
    // usually these are just "connection reset by peer" - not worth crashing over
    console.warn('WS client error:', err.message)
    clients.delete(ws)
  })
})

// this gets called by the workers to push updates to everyone listening
// making it a named export so workers can import it without circular dep issues
// (workers import from server, server imports workers - need to pass broadcast as arg)
const broadcast = (data) => {
  if (clients.size === 0) return // nobody home, skip serialization
  const msg = JSON.stringify(data)
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN = 1
      client.send(msg)
    }
  })
}

// start up the simulation workers - pass broadcast so they can push updates
// doing this after server setup so the db is definitely accessible
const { downloadDatabaseFromBlob } = require('./utils/azureStorage')

async function startServer() {
  // Sync database from Blob Storage if configured
  await downloadDatabaseFromBlob()

  const dbPath = path.join(__dirname, 'data', 'urban_twin.gpkg')
  if (!fs.existsSync(dbPath)) {
    console.error('\n  ❌  Database not found at:', dbPath)
    console.error('  Run `npm run seed` first to generate the mock data.\n')
    process.exit(1)
  }

  const { startFleetSimulator } = require('./workers/fleetSimulator')
  const { startBuildingUpdater } = require('./workers/buildingUpdater')

  startFleetSimulator(broadcast)
  startBuildingUpdater(broadcast)

  const PORT = process.env.PORT || 3001

  server.listen(PORT, () => {
    console.log(`\n  🏙️  Urban Twin API running`)
    console.log(`  HTTP:  http://localhost:${PORT}`)
    console.log(`  WS:    ws://localhost:${PORT}/ws`)
    console.log(`  OGC:   http://localhost:${PORT}/api`)
    console.log(`\n  Workers: fleet simulator (3s) and building simulator (10s) running\n`)
  })
}

startServer().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})

module.exports = { broadcast }
