/* this is the main workhorse - handles all the OGC API Features endpoints.
 * the spec is at ogcapi.ogc.org/features if you need it (bookmark part 1 + core conformance)
 * basically every endpoint returns JSON, geometries are in GeoJSON (EPSG:4326)
 * conformance classes we claim to support are listed in /conformance
 *
 * spent 2 hours figuring out the OGC spec link structure, leaving this comment for future me:
 * - every response needs a 'links' array
 * - self link = current url, alternate = same url with different format (we only do json)
 * - collection items need 'next' link if there are more results
 * - items need a 'collection' link pointing back up
 */

const express = require('express')
const router = express.Router()

const db = require('../db/database')

// base URL helper - we need this for building self/next/collection links
// TODO: make this configurable via env var when we deploy behind a proxy
const getBase = (req) => `${req.protocol}://${req.get('host')}/api`

// ─── Landing Page ─────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const base = getBase(req)
  res.json({
    title: '3D Urban Digital Twin API',
    description: 'OGC API - Features (Part 1: Core) compliant API serving building and fleet data for the study area',
    version: '1.0.0',
    links: [
      { href: base + '/', rel: 'self', type: 'application/json', title: 'This document' },
      { href: base + '/conformance', rel: 'conformance', type: 'application/json', title: 'OGC API conformance classes' },
      { href: base + '/collections', rel: 'data', type: 'application/json', title: 'Feature collections' },
    ]
  })
})

// ─── Conformance ──────────────────────────────────────────────────────────────

router.get('/conformance', (req, res) => {
  // these are the OGC API - Features conformance class URIs
  // if you add a new endpoint type, you need to add the right class here too
  res.json({
    conformsTo: [
      'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
      'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
      'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
    ]
  })
})

// ─── Collections ──────────────────────────────────────────────────────────────

// metadata for each collection we serve - keeping this here so it's easy to update
// rather than computing it every request from the db (which changes during simulation)
const collectionDefs = {
  buildings: {
    id: 'buildings',
    title: 'Urban Twin Buildings',
    description: 'Building footprints and attributes for the digital twin metropolitan area, including height, material, construction status, and NDVI score.',
    geomType: 'Polygon',
  },
  fleet: {
    id: 'fleet',
    title: 'NYC Fleet Vehicles',
    description: 'Real-time positions of simulated city fleet vehicles (delivery, bus, truck, emergency). Updated every 3 seconds.',
    geomType: 'Point',
  },
  ndvi_grid: {
    id: 'ndvi_grid',
    title: 'NDVI Grid',
    description: 'Normalized Difference Vegetation Index grid cells covering the study area at ~200m resolution. Values range from -0.05 (water/shadow) to 0.75 (dense vegetation).',
    geomType: 'Polygon',
  }
}

router.get('/collections', (req, res) => {
  const base = getBase(req)

  const collections = Object.keys(collectionDefs).map(name => {
    const def = collectionDefs[name]
    const meta = db.getCollectionMeta(name)

    return {
      id: def.id,
      title: def.title,
      description: def.description,
      extent: {
        spatial: {
          bbox: [meta.bbox],  // OGC wants bbox as array of arrays
          crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
        }
      },
      itemType: 'feature',
      crs: ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'],
      links: [
        { href: `${base}/collections/${name}`, rel: 'self', type: 'application/json', title: def.title },
        { href: `${base}/collections/${name}/items`, rel: 'items', type: 'application/geo+json', title: `${def.title} features` },
      ]
    }
  })

  res.json({
    collections,
    links: [
      { href: `${base}/collections`, rel: 'self', type: 'application/json', title: 'Feature collections' },
    ]
  })
})

// single collection metadata
router.get('/collections/:name', (req, res) => {
  const { name } = req.params
  const base = getBase(req)

  const def = collectionDefs[name]
  if (!def) {
    return res.status(404).json({ error: 'Collection not found', collection: name })
  }

  const meta = db.getCollectionMeta(name)

  res.json({
    id: def.id,
    title: def.title,
    description: def.description,
    extent: {
      spatial: {
        bbox: [meta.bbox],
        crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
      }
    },
    itemType: 'feature',
    crs: ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'],
    links: [
      { href: `${base}/collections/${name}`, rel: 'self', type: 'application/json', title: def.title },
      { href: `${base}/collections/${name}/items`, rel: 'items', type: 'application/geo+json', title: `${def.title} features` },
      { href: `${base}/collections`, rel: 'parent', type: 'application/json', title: 'Collections' },
    ]
  })
})

// ─── Items (FeatureCollection) ────────────────────────────────────────────────

router.get('/collections/:name/items', (req, res) => {
  const { name } = req.params
  const base = getBase(req)

  if (!collectionDefs[name]) {
    return res.status(404).json({ error: 'Collection not found', collection: name })
  }

  // parse query params
  let limit = parseInt(req.query.limit) || 100
  const offset = parseInt(req.query.offset) || 0

  // clamp limit - don't let someone request 10k features
  if (limit > 500) limit = 500
  if (limit < 1) limit = 1

  // bbox: minLon,minLat,maxLon,maxLat (longitude first per OGC spec)
  let bbox = null
  if (req.query.bbox) {
    const parts = req.query.bbox.split(',').map(Number)
    if (parts.length !== 4 || parts.some(isNaN)) {
      return res.status(400).json({
        error: 'Invalid bbox',
        message: 'bbox must be 4 comma-separated numbers: minLon,minLat,maxLon,maxLat'
      })
    }
    bbox = parts  // [minLon, minLat, maxLon, maxLat]
  }

  try {
    let rows, total
    const geomType = collectionDefs[name].geomType

    // pull rows from db based on collection
    if (name === 'buildings') {
      rows = db.getBuildings(bbox, limit, offset)
      total = db.getCollectionMeta('buildings').count
    } else if (name === 'fleet') {
      rows = db.getFleet(bbox, limit, offset)
      total = db.getCollectionMeta('fleet').count
    } else if (name === 'ndvi_grid') {
      rows = db.getNdviGrid(bbox, limit, offset)
      total = db.getCollectionMeta('ndvi_grid').count
    }

    const features = rows.map(row => db.rowToFeature(row, geomType))

    const links = [
      { href: `${base}/collections/${name}/items`, rel: 'self', type: 'application/geo+json' },
      { href: `${base}/collections/${name}`, rel: 'collection', type: 'application/json' },
    ]

    // add next page link if there are more results
    const hasMore = offset + rows.length < total
    if (hasMore) {
      const nextOffset = offset + limit
      links.push({
        href: `${base}/collections/${name}/items?limit=${limit}&offset=${nextOffset}`,
        rel: 'next',
        type: 'application/geo+json',
        title: 'Next page'
      })
    }

    res.setHeader('Content-Type', 'application/geo+json')
    res.json({
      type: 'FeatureCollection',
      numberMatched: total,       // total matching features (ignoring pagination)
      numberReturned: features.length,  // features in this response
      features,
      links,
    })

  } catch (err) {
    console.error(`Error fetching ${name} items:`, err)
    res.status(500).json({ error: 'Database error', message: err.message })
  }
})

// ─── Single Item ──────────────────────────────────────────────────────────────

router.get('/collections/:name/items/:id', (req, res) => {
  const { name, id } = req.params
  const base = getBase(req)

  if (!collectionDefs[name]) {
    return res.status(404).json({ error: 'Collection not found', collection: name })
  }

  try {
    let row
    const geomType = collectionDefs[name].geomType

    if (name === 'buildings') {
      row = db.getBuildingById(id)
    } else if (name === 'fleet') {
      row = db.getFleetById(id)
    } else if (name === 'ndvi_grid') {
      row = db.getNdviById(id)
    }

    if (!row) {
      return res.status(404).json({ error: 'Feature not found', id })
    }

    const feature = db.rowToFeature(row, geomType)

    // spec says single features need these links
    feature.links = [
      { href: `${base}/collections/${name}/items/${id}`, rel: 'self', type: 'application/geo+json' },
      { href: `${base}/collections/${name}`, rel: 'collection', type: 'application/json' },
    ]

    res.setHeader('Content-Type', 'application/geo+json')
    res.json(feature)

  } catch (err) {
    console.error(`Error fetching ${name}/${id}:`, err)
    res.status(500).json({ error: 'Database error', message: err.message })
  }
})

module.exports = router
