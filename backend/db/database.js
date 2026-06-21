// database.js - OGC GeoPackage Database Connection and Binary Geometry Decoder
// Parses Point/Polygon features directly from standard compliant SQLite BLOB columns.

const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = path.join(__dirname, '..', 'data', 'urban_twin.gpkg')

let _db = null
const getDb = () => {
  if (!_db) {
    _db = new Database(DB_PATH)
    _db.pragma('journal_mode = WAL')
    _db.pragma('synchronous = NORMAL')
  }
  return _db
}

// ─── OGC GeoPackage Binary Geometry Decoder ────────────────────────────────────
// Reference: https://www.geopackage.org/spec131/index.html#gpb_format

const parseGpkgGeometry = (buffer) => {
  if (!buffer || buffer.length < 8) return null
  // check magic bytes "GP"
  if (buffer[0] !== 0x47 || buffer[1] !== 0x50) return null

  const flags = buffer[3]
  const byteOrder = flags & 0x01 // 0 = big endian, 1 = little endian
  const envelopeIndicator = (flags >> 1) & 0x07

  let headerLength = 8
  if (envelopeIndicator === 1) headerLength += 32
  else if (envelopeIndicator === 2 || envelopeIndicator === 3) headerLength += 48

  if (buffer.length < headerLength) return null

  const wkb = buffer.subarray(headerLength)
  return parseWkb(wkb)
}

const parseWkb = (buffer) => {
  if (buffer.length < 5) return null
  const byteOrder = buffer[0] // 1 = little endian, 0 = big endian
  const isLittle = byteOrder === 1

  const readUInt32 = (offset) => isLittle ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  const readDouble = (offset) => isLittle ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset)

  const geomType = readUInt32(1)

  if (geomType === 1) {
    // Point
    const x = readDouble(5)
    const y = readDouble(13)
    return { type: 'Point', coordinates: [x, y] }
  } else if (geomType === 3) {
    // Polygon
    const numRings = readUInt32(5)
    let offset = 9
    const rings = []

    for (let r = 0; r < numRings; r++) {
      const numPoints = readUInt32(offset)
      offset += 4
      const points = []

      for (let p = 0; p < numPoints; p++) {
        const x = readDouble(offset)
        const y = readDouble(offset + 8)
        points.push([x, y])
        offset += 16
      }
      rings.push(points)
    }

    return { type: 'Polygon', coordinates: rings }
  }

  return null
}

// ─── OGC GeoPackage Binary Geometry Encoder ────────────────────────────────────
const toGpkgBinaryGeometry = (geojson) => {
  const header = Buffer.from([0x47, 0x50, 0x00, 0x01, 0xe6, 0x10, 0x00, 0x00]) // GP, ver 0, flags 1 (LE, no envelope), SRS 4326
  let wkb
  if (geojson.type === 'Point') {
    wkb = Buffer.alloc(21)
    wkb[0] = 1 // little endian
    wkb.writeUInt32LE(1, 1) // Point type
    wkb.writeDoubleLE(geojson.coordinates[0], 5)
    wkb.writeDoubleLE(geojson.coordinates[1], 13)
  } else if (geojson.type === 'Polygon') {
    const rings = geojson.coordinates
    let size = 9 // byteOrder (1) + geomType (4) + numRings (4)
    for (const ring of rings) {
      size += 4 + ring.length * 16 // numPoints (4) + points (N * 16)
    }

    wkb = Buffer.alloc(size)
    wkb[0] = 1 // little endian
    wkb.writeUInt32LE(3, 1) // Polygon type
    wkb.writeUInt32LE(rings.length, 5)

    let offset = 9
    for (const ring of rings) {
      wkb.writeUInt32LE(ring.length, offset)
      offset += 4
      for (const pt of ring) {
        wkb.writeDoubleLE(pt[0], offset)
        wkb.writeDoubleLE(pt[1], offset + 8)
        offset += 16
      }
    }
  } else {
    throw new Error('Unsupported geometry type: ' + geojson.type)
  }

  return Buffer.concat([header, wkb])
}

// ─── Centroid & BBOX helper ───────────────────────────────────────────────────
const getCentroid = (geom) => {
  if (!geom) return null
  if (geom.type === 'Point') {
    return { lon: geom.coordinates[0], lat: geom.coordinates[1] }
  }
  if (geom.type === 'Polygon') {
    const ring = geom.coordinates[0]
    if (!ring || ring.length === 0) return null
    const lon = ring.reduce((s, c) => s + c[0], 0) / ring.length
    const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length
    return { lon, lat }
  }
  return null
}

const inBbox = (geom, bbox) => {
  if (!bbox) return true
  const [minLon, minLat, maxLon, maxLat] = bbox
  const c = getCentroid(geom)
  if (!c) return false
  return c.lon >= minLon && c.lon <= maxLon && c.lat >= minLat && c.lat <= maxLat
}

// ─── Row to GeoJSON feature converter ─────────────────────────────────────────
const rowToFeature = (row, geomType) => {
  const { id, geom, ...props } = row

  return {
    type: 'Feature',
    id: id,
    geometry: parseGpkgGeometry(geom),
    properties: {
      ...props,
      featureId: id,
    }
  }
}

// ─── Buildings ────────────────────────────────────────────────────────────────
const getBuildings = (bbox, limit = 100, offset = 0) => {
  const db = getDb()

  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox
    return db.prepare(`
      SELECT b.*
      FROM buildings b
      JOIN rtree_buildings_geom r ON b.id = r.id
      WHERE r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ?
      ORDER BY b.id
      LIMIT ? OFFSET ?
    `).all(maxLon, minLon, maxLat, minLat, limit, offset)
  }

  return db.prepare('SELECT * FROM buildings ORDER BY id LIMIT ? OFFSET ?').all(limit, offset)
}

const getBuildingById = (id) => {
  return getDb().prepare('SELECT * FROM buildings WHERE id = ?').get(id)
}

const updateBuildingStatus = (id, status, height) => {
  getDb()
    .prepare('UPDATE buildings SET status = ?, height = ?, floors = ? WHERE id = ?')
    .run(status, height, Math.round(height / 3.5), id)
}

// ─── Fleet ────────────────────────────────────────────────────────────────────
const getFleet = (bbox, limit = 100, offset = 0) => {
  const db = getDb()

  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox
    return db.prepare(`
      SELECT f.*
      FROM fleet f
      JOIN rtree_fleet_geom r ON f.id = r.id
      WHERE r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ?
      ORDER BY f.id
      LIMIT ? OFFSET ?
    `).all(maxLon, minLon, maxLat, minLat, limit, offset)
  }

  return db.prepare('SELECT * FROM fleet ORDER BY id LIMIT ? OFFSET ?').all(limit, offset)
}

const getFleetById = (id) => {
  return getDb().prepare('SELECT * FROM fleet WHERE id = ?').get(id)
}

const updateFleetPosition = (id, lon, lat, heading, speed, timestamp) => {
  const geom = toGpkgBinaryGeometry({ type: 'Point', coordinates: [lon, lat] })
  const db = getDb()
  db.prepare(`UPDATE fleet
              SET lon = ?, lat = ?, heading = ?, speed = ?, timestamp = ?, geom = ?
              WHERE id = ?`)
    .run(lon, lat, heading, speed, timestamp, geom, id)

  db.prepare(`UPDATE rtree_fleet_geom
              SET minx = ?, maxx = ?, miny = ?, maxy = ?
              WHERE id = ?`)
    .run(lon, lon, lat, lat, id)
}

// ─── NDVI Grid ────────────────────────────────────────────────────────────────
const getNdviGrid = (bbox, limit = 100, offset = 0) => {
  const db = getDb()

  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox
    return db.prepare(`
      SELECT n.*
      FROM ndvi_grid n
      JOIN rtree_ndvi_grid_geom r ON n.id = r.id
      WHERE r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ?
      ORDER BY n.id
      LIMIT ? OFFSET ?
    `).all(maxLon, minLon, maxLat, minLat, limit, offset)
  }

  return db.prepare('SELECT * FROM ndvi_grid ORDER BY id LIMIT ? OFFSET ?').all(limit, offset)
}

const getNdviById = (id) => {
  return getDb().prepare('SELECT * FROM ndvi_grid WHERE id = ?').get(id)
}

// ─── Collection metadata ──────────────────────────────────────────────────────
const getCollectionMeta = (name) => {
  const db = getDb()
  try {
    const row = db.prepare(`SELECT min_x, min_y, max_x, max_y FROM gpkg_contents WHERE table_name = ?`).get(name)
    const countRow = db.prepare(`SELECT COUNT(*) as n FROM ${name}`).get()

    return {
      bbox: row ? [row.min_x, row.min_y, row.max_x, row.max_y] : [-74.0, 40.73, -73.97, 40.77],
      count: countRow.n
    }
  } catch (err) {
    console.warn(`getCollectionMeta failed for ${name}:`, err.message)
    return { bbox: [-74.0, 40.73, -73.97, 40.77], count: 0 }
  }
}

module.exports = {
  getBuildings,
  getBuildingById,
  updateBuildingStatus,
  getFleet,
  getFleetById,
  updateFleetPosition,
  getNdviGrid,
  getNdviById,
  getCollectionMeta,
  rowToFeature,
  parseGpkgGeometry,
  toGpkgBinaryGeometry
}
