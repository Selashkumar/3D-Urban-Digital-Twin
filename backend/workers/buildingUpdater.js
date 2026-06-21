// buildingUpdater.js - simulates construction progress over time
//
// runs every 45 seconds and nudges 1-2 buildings that are under construction.
// the idea is that the 3D viewer shows buildings growing taller as you watch
// which makes the "digital twin" feel live even when fleet movement is the main show.
//
// height thresholds for status transitions:
//   planned     → construction when height > 0 (just started)
//   construction → operational when height >= target_height (construction done)
//
// we don't store target_height in the db (maybe we should? TODO), so we just
// pick a reasonable max based on the number of floors that were seeded

'use strict'

const cron = require('node-cron')
const db = require('../db/database')

// how much height to add per update (meters) - roughly 1-2 floors
const HEIGHT_INCREMENT_MIN = 3.5   // one floor
const HEIGHT_INCREMENT_MAX = 10.5  // three floors

let _broadcast = null

const buildingUpdateTick = () => {
  try {
    const allBuildings = db.getBuildings()  // no filters, get all

    // find buildings that are actively being constructed or in planned state
    const constructionBldgs = allBuildings.filter(b =>
      b.status === 'construction' || b.status === 'planned'
    )

    if (constructionBldgs.length === 0) {
      // nothing to update, silently return
      return
    }

    // pick 1 or 2 buildings at random to "progress"
    // using 1-2 instead of always 2 so updates feel less mechanical
    const numToUpdate = Math.random() < 0.6 ? 1 : 2
    const shuffled = [...constructionBldgs].sort(() => Math.random() - 0.5)
    const targets = shuffled.slice(0, numToUpdate)

    const updatedFeatures = []

    for (const bldg of targets) {
      const increment = HEIGHT_INCREMENT_MIN + Math.random() * (HEIGHT_INCREMENT_MAX - HEIGHT_INCREMENT_MIN)
      let newHeight = parseFloat((bldg.height + increment).toFixed(1))

      // planned buildings: kick them into construction when they "break ground"
      // just treat any planned building as starting from 0 height effectively
      let newStatus = bldg.status
      if (bldg.status === 'planned') {
        newStatus = 'construction'
        newHeight = 5  // just started, 5m above grade
      } else {
        // construction → operational when we hit a reasonable finished height
        // using floors * 3.5 as the target (restoring original seeded height intent)
        // the seeded height might have been reduced if this building was already in construction
        // this is a bit rough but good enough for a demo
        const targetFloors = bldg.floors || Math.round(bldg.height / 3.5)
        const targetH = Math.max(targetFloors * 3.5, 20)  // at least 20m

        if (newHeight >= targetH) {
          newHeight = targetH
          newStatus = 'operational'
          console.log(`  🏗️  Building ${bldg.id} (${bldg.name}) completed construction`)
        }
      }

      db.updateBuildingStatus(bldg.id, newStatus, newHeight)

      // need the updated row to send in broadcast - reconstruct it manually
      // since updateBuildingStatus doesn't return the updated row
      const updatedRow = {
        ...bldg,
        height: newHeight,
        floors: Math.round(newHeight / 3.5),
        status: newStatus,
      }

      updatedFeatures.push(db.rowToFeature(updatedRow, 'Polygon'))
    }

    if (_broadcast && updatedFeatures.length > 0) {
      _broadcast({
        type: 'building_update',
        timestamp: new Date().toISOString(),
        features: updatedFeatures,
      })
    }

  } catch (err) {
    // don't let a db error kill the cron job - just log and move on
    console.error('Building updater error:', err.message)
  }
}

const startBuildingUpdater = (broadcastFn) => {
  _broadcast = broadcastFn
  console.log('  → Building updater started (tick every 45s)')

  // '*/45 * * * * *' = every 45 seconds (6-field cron with seconds)
  // node-cron supports this with the { scheduled: true } option
  cron.schedule('*/45 * * * * *', buildingUpdateTick)
}

module.exports = { startBuildingUpdater }
