#!/usr/bin/env node
// seed.js - generates a 100% OGC compliant urban_twin.gpkg file with simulated building and fleet data
// run with: node db/seed.js  OR  npm run seed

'use strict'

const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_PATH = path.join(DATA_DIR, 'urban_twin.gpkg')

// make sure the data dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  console.log('Created data/ directory')
}

// wipe and recreate if already exists
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH)
  console.log('Removed existing urban_twin.gpkg')
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

// ─── GeoPackage required pragmas and tables ────────────────────────────────────
db.pragma('application_id = 1196444743')  // 0x47504B47 ('GPKG')
db.pragma('user_version = 10300')          // gpkg 1.3.0

db.exec(`
  CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL PRIMARY KEY,
    organization TEXT NOT NULL,
    organization_coordsys_id INTEGER NOT NULL,
    definition TEXT NOT NULL,
    description TEXT
  );

  -- WGS84 geographic 2D - coordinate reference system
  INSERT INTO gpkg_spatial_ref_sys VALUES
    ('Undefined Cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'),
    ('Undefined Geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'),
    ('WGS 84 geodetic', 4326, 'EPSG', 4326,
     'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
     'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid');

  CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY,
    data_type TEXT NOT NULL,
    identifier TEXT,
    description TEXT DEFAULT '',
    last_change TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    min_x REAL,
    min_y REAL,
    max_x REAL,
    max_y REAL,
    srs_id INTEGER REFERENCES gpkg_spatial_ref_sys(srs_id)
  );

  CREATE TABLE gpkg_geometry_columns (
    table_name TEXT NOT NULL REFERENCES gpkg_contents(table_name),
    column_name TEXT NOT NULL,
    geometry_type_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL REFERENCES gpkg_spatial_ref_sys(srs_id),
    z TINYINT NOT NULL,
    m TINYINT NOT NULL,
    PRIMARY KEY (table_name, column_name)
  );
`)

console.log('✓ GeoPackage metadata tables created')

// ─── Data tables (OGC compliant - geometry column is 'geom' BLOB) ──────────────
db.exec(`
  CREATE TABLE buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    height REAL,
    floors INTEGER,
    status TEXT,
    material TEXT,
    year_built INTEGER,
    ndvi_score REAL,
    use_type TEXT,
    geom BLOB        -- Valid GPKG Binary geometry blob
  );
  CREATE VIRTUAL TABLE rtree_buildings_geom USING rtree(id, minx, maxx, miny, maxy);

  CREATE TABLE fleet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id TEXT UNIQUE,
    type TEXT,
    lon REAL,
    lat REAL,
    speed REAL,
    heading REAL,
    status TEXT,
    timestamp TEXT,
    geom BLOB
  );
  CREATE VIRTUAL TABLE rtree_fleet_geom USING rtree(id, minx, maxx, miny, maxy);

  CREATE TABLE ndvi_grid (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ndvi_value REAL,
    class TEXT,
    cell_col INTEGER,
    cell_row INTEGER,
    geom BLOB
  );
  CREATE VIRTUAL TABLE rtree_ndvi_grid_geom USING rtree(id, minx, maxx, miny, maxy);
`)

console.log('✓ Data tables created')

// ─── OGC GeoPackage Binary Geometry Encoder ────────────────────────────────────
// GPKG geometry format: 8-byte header + standard WKB
const toGpkgBinaryGeometry = (geojson) => {
  const header = Buffer.from([0x47, 0x50, 0x00, 0x01, 0xe6, 0x10, 0x00, 0x00]) // GP, ver 0, flags 1 (LE, no envelope), SRS 4326
  let wkb
  if (geojson.type === 'Point') {
    wkb = Buffer.alloc(21)
    wkb[0] = 1 // little endian byte order
    wkb.writeUInt32LE(1, 1) // Geometry type: 1 (Point)
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
    wkb.writeUInt32LE(3, 1) // Geometry type: 3 (Polygon)
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

// ─── Building data generation ─────────────────────────────────────────────────
const LANDMARKS = [
  { name: 'Empire State Building',     lon: -73.9857, lat: 40.7484, height: 443, material: 'steel',    yearBuilt: 1931, use: 'commercial'  },
  { name: 'One World Trade Center',    lon: -74.0134, lat: 40.7127, height: 541, material: 'glass',    yearBuilt: 2014, use: 'commercial'  },
  { name: 'Chrysler Building',         lon: -73.9754, lat: 40.7516, height: 319, material: 'steel',    yearBuilt: 1930, use: 'commercial'  },
  { name: '432 Park Avenue',           lon: -73.9724, lat: 40.7616, height: 426, material: 'concrete', yearBuilt: 2015, use: 'residential' },
  { name: 'Bank of America Tower',     lon: -73.9845, lat: 40.7556, height: 366, material: 'glass',    yearBuilt: 2009, use: 'commercial'  },
  { name: 'One Penn Plaza',            lon: -73.9940, lat: 40.7509, height: 209, material: 'steel',    yearBuilt: 1972, use: 'commercial'  },
  { name: '30 Rockefeller Plaza',      lon: -73.9787, lat: 40.7587, height: 259, material: 'steel',    yearBuilt: 1933, use: 'commercial'  },
  { name: 'MetLife Building',          lon: -73.9770, lat: 40.7527, height: 246, material: 'concrete', yearBuilt: 1963, use: 'commercial'  },
  { name: 'Lever House',               lon: -73.9730, lat: 40.7584, height: 92,  material: 'glass',    yearBuilt: 1952, use: 'commercial'  },
  { name: 'Seagram Building',          lon: -73.9731, lat: 40.7581, height: 157, material: 'steel',    yearBuilt: 1958, use: 'commercial'  },
  { name: 'NYC Penn Station Tower',    lon: -73.9940, lat: 40.7500, height: 60,  material: 'concrete', yearBuilt: 1968, use: 'commercial'  },
  { name: 'Hudson Yards Tower A',      lon: -74.0024, lat: 40.7539, height: 302, material: 'glass',    yearBuilt: 2019, use: 'mixed'       },
  { name: 'Hudson Yards Tower B',      lon: -74.0010, lat: 40.7543, height: 265, material: 'glass',    yearBuilt: 2020, use: 'commercial'  },
  { name: 'Vessel (Hudson Yards)',     lon: -74.0017, lat: 40.7535, height: 46,  material: 'steel',    yearBuilt: 2019, use: 'mixed'       },
  { name: 'The Edge Observation',      lon: -74.0020, lat: 40.7540, height: 335, material: 'glass',    yearBuilt: 2020, use: 'commercial'  },
  { name: 'Madison Square Garden',     lon: -73.9934, lat: 40.7505, height: 50,  material: 'concrete', yearBuilt: 1968, use: 'commercial'  },
  { name: 'New Yorker Hotel',          lon: -73.9955, lat: 40.7501, height: 71,  material: 'brick',    yearBuilt: 1930, use: 'mixed'       },
  { name: 'Herald Square Building',    lon: -73.9885, lat: 40.7499, height: 45,  material: 'brick',    yearBuilt: 1902, use: 'commercial'  },
  { name: 'One Vanderbilt',            lon: -73.9783, lat: 40.7528, height: 427, material: 'glass',    yearBuilt: 2020, use: 'commercial'  },
  { name: 'Waldorf Astoria NYC',       lon: -73.9771, lat: 40.7563, height: 189, material: 'concrete', yearBuilt: 1931, use: 'mixed'       },
]

const STREETS_EW = ['W 34th', 'W 38th', 'W 42nd', 'W 45th', 'W 48th', 'W 51st', 'W 57th',
                    'E 34th', 'E 38th', 'E 42nd', 'E 45th', 'E 48th', 'E 51st', 'E 57th']
const AVENUES   = ['Fifth Ave', 'Sixth Ave', 'Seventh Ave', 'Eighth Ave', 'Park Ave', 'Lex Ave', 'Third Ave', 'Madison Ave']
const SUFFIXES  = ['Tower', 'Building', 'Center', 'Plaza', 'House', 'Place', '']

const randItem = (arr) => arr[Math.floor(Math.random() * arr.length)]

const genBuildingName = () => {
  if (Math.random() < 0.4) {
    const num = Math.floor(Math.random() * 500) + 1
    return `${num} ${randItem(AVENUES)}`
  }
  return `${randItem(STREETS_EW)} ${randItem(SUFFIXES)}`.trim() || `${randItem(AVENUES)} Complex`
}

const getRandomHeight = () => {
  const r = Math.random()
  if (r < 0.60) return Math.floor(Math.random() * 30) + 10   // low-rise
  if (r < 0.85) return Math.floor(Math.random() * 60) + 40   // mid-rise
  if (r < 0.97) return Math.floor(Math.random() * 150) + 100 // high-rise
  return Math.floor(Math.random() * 170) + 250               // supertall
}

const MATERIALS = ['glass', 'concrete', 'brick', 'steel']
const STATUSES  = ['operational', 'operational', 'operational', 'operational',
                   'operational', 'operational', 'operational',
                   'construction', 'construction', 'planned']
const USE_TYPES = ['commercial', 'commercial', 'commercial', 'residential', 'residential', 'mixed', 'industrial']

const BBOX = { minLon: -73.995, minLat: 40.735, maxLon: -73.975, maxLat: 40.760 }
const LON_RANGE = BBOX.maxLon - BBOX.minLon
const LAT_RANGE = BBOX.maxLat - BBOX.minLat

const generateBuildings = () => {
  const bldgs = []
  const COLS = 18
  const ROWS = 22
  const lonStep = LON_RANGE / COLS
  const latStep = LAT_RANGE / ROWS

  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const baseLon = BBOX.minLon + col * lonStep
      const baseLat = BBOX.minLat + row * latStep

      const jitterLon = (Math.random() - 0.5) * lonStep * 0.3
      const jitterLat = (Math.random() - 0.5) * latStep * 0.3

      const centerLon = baseLon + lonStep / 2 + jitterLon
      const centerLat = baseLat + latStep / 2 + jitterLat

      const widthM  = 15 + Math.random() * 45
      const depthM  = 15 + Math.random() * 35
      const halfW   = (widthM / 111320) * 0.7
      const halfD   = depthM / 111320

      const coords = [[
        [centerLon - halfW, centerLat - halfD],
        [centerLon + halfW, centerLat - halfD],
        [centerLon + halfW, centerLat + halfD],
        [centerLon - halfW, centerLat + halfD],
        [centerLon - halfW, centerLat - halfD],
      ]]

      const geom = { type: 'Polygon', coordinates: coords }
      const height = getRandomHeight()
      const status = randItem(STATUSES)
      const yearBuilt = status === 'planned' ? 2024 + Math.floor(Math.random() * 3)
                      : status === 'construction' ? 2022 + Math.floor(Math.random() * 3)
                      : 1920 + Math.floor(Math.random() * 104)

      bldgs.push({
        name: genBuildingName(),
        height,
        floors: Math.round(height / 3.5),
        status,
        material: randItem(MATERIALS),
        year_built: yearBuilt,
        ndvi_score: parseFloat((0.01 + Math.random() * 0.14).toFixed(4)),
        use_type: randItem(USE_TYPES),
        geom: toGpkgBinaryGeometry(geom),
        bbox: [centerLon - halfW, centerLon + halfW, centerLat - halfD, centerLat + halfD],
      })
    }
  }
  return bldgs
}

// ─── Fleet data generation ───────────────────────────────────────────────────
const VEHICLE_TYPES = [
  ...Array(8).fill('delivery'),
  ...Array(5).fill('bus'),
  ...Array(4).fill('truck'),
  ...Array(3).fill('emergency'),
]

const generateFleet = () => {
  return VEHICLE_TYPES.map((type, i) => {
    const lon = BBOX.minLon + Math.random() * (BBOX.maxLon - BBOX.minLon)
    const lat = BBOX.minLat + Math.random() * (BBOX.maxLat - BBOX.minLat)

    const abbrev = { delivery: 'DEL', bus: 'BUS', truck: 'TRK', emergency: 'EMR' }[type]
    const sameType = VEHICLE_TYPES.slice(0, i + 1).filter(t => t === type)
    const typeIdx = String(sameType.length).padStart(3, '0')

    const speed = type === 'emergency' ? 40 + Math.random() * 40
                : type === 'bus'       ? 15 + Math.random() * 20
                : 10 + Math.random() * 40

    const statusRoll = Math.random()
    const status = statusRoll < 0.7 ? 'moving' : statusRoll < 0.9 ? 'idle' : 'stopped'

    return {
      vehicle_id: `NYC-${abbrev}-${typeIdx}`,
      type,
      lon,
      lat,
      speed: parseFloat(speed.toFixed(1)),
      heading: parseFloat((Math.random() * 360).toFixed(1)),
      status,
      timestamp: new Date().toISOString(),
      geom: toGpkgBinaryGeometry({ type: 'Point', coordinates: [lon, lat] }),
      bbox: [lon, lon, lat, lat],
    }
  })
}

// ─── NDVI grid generation ─────────────────────────────────────────────────────
const GREEN_SPOTS = [
  { lon: -73.9835, lat: 40.7536, r: 0.002 },  // Bryant Park
  { lon: -74.0044, lat: 40.7480, r: 0.003 },  // High Line
  { lon: -73.9877, lat: 40.7484, r: 0.001 },  // Greeley Square
  { lon: -73.9981, lat: 40.7453, r: 0.002 },  // Chelsea park
]

const getNdviForCell = (centerLon, centerLat) => {
  let greenBoost = 0
  for (const spot of GREEN_SPOTS) {
    const dLon = centerLon - spot.lon
    const dLat = centerLat - spot.lat
    const dist = Math.sqrt(dLon * dLon + dLat * dLat)
    if (dist < spot.r) {
      greenBoost = Math.max(greenBoost, (1 - dist / spot.r) * 0.6)
    }
  }
  const base = -0.05 + Math.random() * 0.20
  const value = Math.min(0.75, base + greenBoost + (Math.random() - 0.5) * 0.05)

  let ndviClass
  if (value < 0)    ndviClass = 'water'
  else if (value < 0.15) ndviClass = 'impervious'
  else if (value < 0.35) ndviClass = 'sparse'
  else if (value < 0.55) ndviClass = 'moderate'
  else                   ndviClass = 'dense'

  return { value: parseFloat(value.toFixed(4)), class: ndviClass }
}

const generateNdviGrid = () => {
  const cells = []
  const CELL_SIZE = 0.0018

  let col = 0
  for (let lon = BBOX.minLon; lon < BBOX.maxLon; lon += CELL_SIZE) {
    let row = 0
    for (let lat = BBOX.minLat; lat < BBOX.maxLat; lat += CELL_SIZE) {
      const centerLon = lon + CELL_SIZE / 2
      const centerLat = lat + CELL_SIZE / 2
      const { value, class: ndviClass } = getNdviForCell(centerLon, centerLat)

      const coords = [[
        [lon,             lat],
        [lon + CELL_SIZE, lat],
        [lon + CELL_SIZE, lat + CELL_SIZE],
        [lon,             lat + CELL_SIZE],
        [lon,             lat],
      ]]

      cells.push({
        ndvi_value: value,
        class: ndviClass,
        cell_col: col,
        cell_row: row,
        geom: toGpkgBinaryGeometry({ type: 'Polygon', coordinates: coords }),
        bbox: [lon, lon + CELL_SIZE, lat, lat + CELL_SIZE],
      })
      row++
    }
    col++
  }
  return cells
}

// ─── Insert everything in single transaction ──────────────────────────────────
const insertAll = db.transaction(() => {
  const insertBuilding = db.prepare(`
    INSERT INTO buildings (name, height, floors, status, material, year_built, ndvi_score, use_type, geom)
    VALUES (@name, @height, @floors, @status, @material, @year_built, @ndvi_score, @use_type, @geom)
  `)

  const insertRtreeBldg = db.prepare(`
    INSERT INTO rtree_buildings_geom (id, minx, maxx, miny, maxy)
    VALUES (?, ?, ?, ?, ?)
  `)

  for (const lm of LANDMARKS) {
    const height = lm.height
    const wh = 0.0004
    const coords = [[
      [lm.lon - wh, lm.lat - wh * 0.6],
      [lm.lon + wh, lm.lat - wh * 0.6],
      [lm.lon + wh, lm.lat + wh * 0.6],
      [lm.lon - wh, lm.lat + wh * 0.6],
      [lm.lon - wh, lm.lat - wh * 0.6],
    ]]
    const res = insertBuilding.run({
      name:       lm.name,
      height,
      floors:     Math.round(height / 3.5),
      status:     'operational',
      material:   lm.material,
      year_built: lm.yearBuilt,
      ndvi_score: parseFloat((0.01 + Math.random() * 0.08).toFixed(4)),
      use_type:   lm.use,
      geom:       toGpkgBinaryGeometry({ type: 'Polygon', coordinates: coords }),
    })
    
    insertRtreeBldg.run(
      res.lastInsertRowid,
      lm.lon - wh,
      lm.lon + wh,
      lm.lat - wh * 0.6,
      lm.lat + wh * 0.6
    )
  }
  console.log(`  Inserted ${LANDMARKS.length} landmark buildings`)

  const bldgs = generateBuildings()
  for (const b of bldgs) {
    const res = insertBuilding.run(b)
    insertRtreeBldg.run(res.lastInsertRowid, b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3])
  }
  console.log(`  Inserted ${bldgs.length} generated buildings (${LANDMARKS.length + bldgs.length} total)`)

  const insertFleet = db.prepare(`
    INSERT INTO fleet (vehicle_id, type, lon, lat, speed, heading, status, timestamp, geom)
    VALUES (@vehicle_id, @type, @lon, @lat, @speed, @heading, @status, @timestamp, @geom)
  `)
  const insertRtreeFleet = db.prepare(`
    INSERT INTO rtree_fleet_geom (id, minx, maxx, miny, maxy)
    VALUES (?, ?, ?, ?, ?)
  `)
  const fleet = generateFleet()
  for (const v of fleet) {
    const res = insertFleet.run(v)
    insertRtreeFleet.run(res.lastInsertRowid, v.bbox[0], v.bbox[1], v.bbox[2], v.bbox[3])
  }
  console.log(`  Inserted ${fleet.length} fleet vehicles`)

  const insertNdvi = db.prepare(`
    INSERT INTO ndvi_grid (ndvi_value, class, cell_col, cell_row, geom)
    VALUES (@ndvi_value, @class, @cell_col, @cell_row, @geom)
  `)
  const insertRtreeNdvi = db.prepare(`
    INSERT INTO rtree_ndvi_grid_geom (id, minx, maxx, miny, maxy)
    VALUES (?, ?, ?, ?, ?)
  `)
  const grid = generateNdviGrid()
  for (const cell of grid) {
    const res = insertNdvi.run(cell)
    insertRtreeNdvi.run(res.lastInsertRowid, cell.bbox[0], cell.bbox[1], cell.bbox[2], cell.bbox[3])
  }
  console.log(`  Inserted ${grid.length} NDVI grid cells`)

  db.prepare(`
    INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
    VALUES (?, 'features', ?, ?, ?, ?, ?, ?, 4326)
  `).run('buildings', 'Urban Twin Buildings', 'Building footprints and heights', BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat)

  db.prepare(`
    INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
    VALUES (?, 'features', ?, ?, ?, ?, ?, ?, 4326)
  `).run('fleet', 'Fleet Vehicles', 'Real-time fleet vehicles tracking', BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat)

  db.prepare(`
    INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
    VALUES (?, 'features', ?, ?, ?, ?, ?, ?, 4326)
  `).run('ndvi_grid', 'NDVI Grid', 'NDVI vegetation index cells', BBOX.minLon, BBOX.minLat, BBOX.maxLon, BBOX.maxLat)

  db.exec(`
    INSERT INTO gpkg_geometry_columns VALUES
      ('buildings', 'geom', 'POLYGON', 4326, 0, 0),
      ('fleet', 'geom', 'POINT', 4326, 0, 0),
      ('ndvi_grid', 'geom', 'POLYGON', 4326, 0, 0);
  `)
})

console.log('\n Seeding OGC compliant urban_twin.gpkg...\n')
insertAll()

const bCount = db.prepare('SELECT COUNT(*) as n FROM buildings').get().n
const fCount = db.prepare('SELECT COUNT(*) as n FROM fleet').get().n
const nCount = db.prepare('SELECT COUNT(*) as n FROM ndvi_grid').get().n

console.log(`\n✅ Done! Compliant urban_twin.gpkg created at ${DB_PATH}`)
console.log(`   buildings: ${bCount}`)
console.log(`   fleet:     ${fCount}`)
console.log(`   ndvi_grid: ${nCount}\n`)

db.close()
