// fleet simulator - moves vehicles around the city bbox every 3 seconds
//
// this is intentionally a very simple linear movement model:
//   new_lon = old_lon + cos(heading_rad) * speed_deg_per_tick
//   new_lat = old_lat + sin(heading_rad) * speed_deg_per_tick
//
// not real routing, not snapped to streets, just continuous motion so the
// 3D viewer has something to show. a real version would use OSRM or Valhalla
// for turn-by-turn navigation along actual streets.
//
// TODO: maybe add a "pause at intersection" behavior to make it look more realistic

'use strict'

const db = require('../db/database')

// city bbox - if a vehicle exits this, we bounce it back
const BBOX = {
  minLon: -73.996,
  minLat:  40.734,
  maxLon: -73.974,
  maxLat:  40.761,
}

// speed conversion: km/h → degrees per second
// at city latitude, 1 degree lon ≈ 84.7km, 1 degree lat ≈ 111km
// we update every 3 seconds so multiply by 3
const KMH_TO_DEG_LAT_PER_SEC = 1 / 111000 / 3.6   // km/h → deg lat per second
const KMH_TO_DEG_LON_PER_SEC = 1 / 84700  / 3.6   // km/h → deg lon per second (at ~40.7°N)

// tick interval in ms - 3 seconds
const TICK_MS = 3000

let _broadcast = null  // set on start

const movementTick = () => {
  const fleet = db.getFleet()  // get all vehicles (no bbox filter, no limit)
  const updated = []

  for (const vehicle of fleet) {
    if (vehicle.status === 'stopped') {
      // stopped vehicles don't move, but we still include them in the broadcast
      // so the client knows their status hasn't changed
      updated.push(vehicle)
      continue
    }

    // idle vehicles move very slowly or not at all
    const effectiveSpeed = vehicle.status === 'idle'
      ? vehicle.speed * 0.1
      : vehicle.speed

    const headingRad = (vehicle.heading * Math.PI) / 180

    // cartesian movement approximation (fine for small areas like midtown)
    let newLon = vehicle.lon + Math.cos(headingRad) * effectiveSpeed * KMH_TO_DEG_LON_PER_SEC * (TICK_MS / 1000)
    let newLat = vehicle.lat + Math.sin(headingRad) * effectiveSpeed * KMH_TO_DEG_LAT_PER_SEC * (TICK_MS / 1000)

    let newHeading = vehicle.heading

    // boundary check - if out of bbox, reverse heading component
    // this creates a "bouncing" behavior which looks more natural than teleporting
    if (newLon < BBOX.minLon || newLon > BBOX.maxLon) {
      newHeading = 180 - newHeading  // flip east-west component
      newLon = Math.max(BBOX.minLon, Math.min(BBOX.maxLon, newLon))
    }
    if (newLat < BBOX.minLat || newLat > BBOX.maxLat) {
      newHeading = -newHeading  // flip north-south component
      newLat = Math.max(BBOX.minLat, Math.min(BBOX.maxLat, newLat))
    }

    // normalize heading to [0, 360)
    newHeading = ((newHeading % 360) + 360) % 360

    // small random heading drift to make paths less robotic
    // ±5 degrees per tick max
    const drift = (Math.random() - 0.5) * 10
    newHeading = ((newHeading + drift) % 360 + 360) % 360

    const ts = new Date().toISOString()
    db.updateFleetPosition(vehicle.id, newLon, newLat, newHeading, vehicle.speed, ts)

    updated.push({
      ...vehicle,
      lon: newLon,
      lat: newLat,
      heading: newHeading,
      timestamp: ts,
      geom: db.toGpkgBinaryGeometry({ type: 'Point', coordinates: [newLon, newLat] }),
    })
  }

  // push updated fleet to all WS clients as GeoJSON features
  if (_broadcast && updated.length > 0) {
    const features = updated.map(v => db.rowToFeature(v, 'Point'))
    _broadcast({
      type: 'fleet_update',
      timestamp: new Date().toISOString(),
      features,
    })
  }
}

const startFleetSimulator = (broadcastFn) => {
  _broadcast = broadcastFn
  console.log('  → Fleet simulator started (tick every 3s)')
  // using setInterval rather than node-cron here because 3 seconds is below
  // cron's 1-minute minimum resolution. node-cron does support seconds with
  // the 6-field format but setInterval is clearer for sub-minute intervals
  setInterval(movementTick, TICK_MS)
}

module.exports = { startFleetSimulator }
