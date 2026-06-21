/* the map component is the heart of this whole thing.
   everything else is just UI around it — the sidebar, popups, stats bar,
   they're all just reading state that this component produces.

   this component owns:
   - the MapLibre map instance
   - all GeoJSON sources + layers
   - hover/click interactions
   - layer visibility toggling
   - reacting to WS updates
*/

import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import {
  MAP_CENTER,
  MAP_ZOOM,
  MAP_PITCH,
  MAP_BEARING,
  CITY_BOUNDS,
  CITY_BBOX,
  buildMapStyle,
  buildNDVIColorExpression,
} from '../utils/mapConfig'
import { apiUrl } from '../utils/apiConfig'

export default function Map3D({
  layerVisibility = { buildings: true, fleet: true, ndvi: false, terrain: false },
  onBuildingClick,
  lastFleetUpdate,
  lastBuildingUpdate,
  extrusionMultiplier = 1,
}) {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  // track which building is hovered for highlight effect
  const hoveredBuildingId = useRef(null)
  // flag so we don't try to update sources before the map has finished loading
  const mapReadyRef = useRef(false)

  // ── initial fetch helpers ─────────────────────────────────────────
  // these are just thin wrappers around fetch — nothing fancy

  async function fetchBuildings() {
    try {
      const res = await fetch(apiUrl(`/api/collections/buildings/items?bbox=${CITY_BBOX}&limit=500`))
      if (!res.ok) throw new Error(`buildings fetch failed: ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn('[Map3D] could not load buildings:', err.message)
      // return an empty feature collection so the source still gets added
      return { type: 'FeatureCollection', features: [] }
    }
  }

  async function fetchFleet() {
    try {
      const res = await fetch(apiUrl('/api/collections/fleet/items'))
      if (!res.ok) throw new Error(`fleet fetch failed: ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn('[Map3D] could not load fleet:', err.message)
      return { type: 'FeatureCollection', features: [] }
    }
  }

  async function fetchNDVI() {
    try {
      const res = await fetch(apiUrl(`/api/collections/ndvi_grid/items?bbox=${CITY_BBOX}`))
      if (!res.ok) throw new Error(`ndvi fetch failed: ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn('[Map3D] could not load NDVI grid:', err.message)
      return { type: 'FeatureCollection', features: [] }
    }
  }

  // ── map init ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainerRef.current) return

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: buildMapStyle(),
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      pitch: MAP_PITCH,
      bearing: MAP_BEARING,
      maxBounds: CITY_BOUNDS,
      antialias: true, // smoother 3D rendering, slight perf cost but worth it
    })

    mapRef.current = map

    // add navigation controls — bottom right so they don't collide with the sidebar
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right')

    // NOTE: you have to wait for the 'load' event before adding layers
    // wasted an hour on this — addLayer before load just throws silently
    map.on('load', async () => {


      // set terrain initially if active
      if (layerVisibility.terrain) {
        map.setTerrain({ source: 'terrain-dem', exaggeration: 2.0 })
      }

      // fetch all data in parallel
      const [buildingData, fleetData, ndviData] = await Promise.all([
        fetchBuildings(),
        fetchFleet(),
        fetchNDVI(),
      ])

      // ── NDVI layer ────────────────────────────────────────────────
      // goes in first so buildings render on top of it
      map.addSource('ndvi', {
        type: 'geojson',
        data: ndviData,
      })

      map.addLayer({
        id: 'ndvi-fill',
        type: 'fill',
        source: 'ndvi',
        paint: {
          'fill-color': buildNDVIColorExpression(),
          'fill-opacity': 0.6,
          'fill-outline-color': 'rgba(0,0,0,0)',
        },
        layout: {
          visibility: layerVisibility.ndvi ? 'visible' : 'none',
        },
      })

      // ── buildings layer ───────────────────────────────────────────
      map.addSource('buildings', {
        type: 'geojson',
        data: buildingData,
        // enable feature state for hover highlighting
        generateId: true,
        promoteId: 'featureId',
      })

      // fill-extrusion is where the 3D magic happens
      // data-driven styling with ['get', 'height'] reads the height property from each feature
      // the color-coded by use_type makes it much easier to understand the city at a glance
      map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          // color-code buildings by type
          'fill-extrusion-color': [
            'case',
            ['boolean', ['feature-state', 'hovered'], false],
            '#ffffff', // bright white on hover
            [
              'match', ['get', 'use_type'],
              'commercial',  '#1a6fff',
              'residential', '#9333ea',
              'mixed',       '#06b6d4',
              'industrial',  '#f97316',
              '#556688', // fallback for anything else
            ],
          ],

          // height from the feature properties, direct from the API
          // multiplier lets the user exaggerate/reduce height for readability
          'fill-extrusion-height': [
            '*',
            ['coalesce', ['get', 'height'], 10],
            extrusionMultiplier,
          ],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': [
            'case',
            ['boolean', ['feature-state', 'hovered'], false],
            0.95,
            0.82,
          ],
          // subtle vertical gradient makes the buildings look more realistic
          'fill-extrusion-vertical-gradient': true,
        },
        layout: {
          visibility: layerVisibility.buildings ? 'visible' : 'none',
        },
      })

      // ── fleet layer ───────────────────────────────────────────────
      map.addSource('fleet', {
        type: 'geojson',
        data: fleetData,
      })

      map.addLayer({
        id: 'fleet-glow',
        type: 'circle',
        source: 'fleet',
        paint: {
          'circle-radius': 16,
          'circle-color': [
            'match', ['get', 'type'],
            'truck',     '#f97316',
            'bus',       '#22c55e',
            'emergency', '#ef4444',
            'delivery',  '#3b82f6',
            '#8899cc',
          ],
          'circle-opacity': 0.15,
          'circle-blur': 1,
        },
        layout: {
          visibility: layerVisibility.fleet ? 'visible' : 'none',
        },
      })

      map.addLayer({
        id: 'fleet-circles',
        type: 'circle',
        source: 'fleet',
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match', ['get', 'type'],
            'truck',     '#f97316',
            'bus',       '#22c55e',
            'emergency', '#ef4444',
            'delivery',  '#3b82f6',
            '#8899cc',
          ],
          'circle-stroke-color': 'rgba(255,255,255,0.4)',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.95,
        },
        layout: {
          visibility: layerVisibility.fleet ? 'visible' : 'none',
        },
      })

      // ── interaction: building hover ───────────────────────────────
      map.on('mousemove', 'buildings-3d', (e) => {
        if (e.features.length === 0) return

        map.getCanvas().style.cursor = 'pointer'

        const featureId = e.features[0].id
        if (featureId === undefined) return

        // clear previous hover state
        if (hoveredBuildingId.current !== null) {
          map.setFeatureState(
            { source: 'buildings', id: hoveredBuildingId.current },
            { hovered: false }
          )
        }

        hoveredBuildingId.current = featureId
        map.setFeatureState(
          { source: 'buildings', id: featureId },
          { hovered: true }
        )
      })

      map.on('mouseleave', 'buildings-3d', () => {
        map.getCanvas().style.cursor = ''

        if (hoveredBuildingId.current !== null) {
          map.setFeatureState(
            { source: 'buildings', id: hoveredBuildingId.current },
            { hovered: false }
          )
          hoveredBuildingId.current = null
        }
      })

      // ── interaction: building click ───────────────────────────────
      map.on('click', 'buildings-3d', (e) => {
        if (e.features.length === 0) return
        const feature = e.features[0]
        onBuildingClick && onBuildingClick(feature)
      })

      // click elsewhere → clear selection
      map.on('click', (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ['buildings-3d'],
        })
        if (features.length === 0) {
          onBuildingClick && onBuildingClick(null)
        }
      })

      // ── fleet hover cursor ────────────────────────────────────────
      map.on('mouseenter', 'fleet-circles', () => {
        map.getCanvas().style.cursor = 'crosshair'
      })
      map.on('mouseleave', 'fleet-circles', () => {
        map.getCanvas().style.cursor = ''
      })

      mapReadyRef.current = true
    })

    // cleanup — important to remove the map instance on unmount
    // otherwise you'll get WebGL context errors and memory leaks
    return () => {
      mapReadyRef.current = false
      map.remove()
      mapRef.current = null
    }
  }, []) // intentionally empty deps — map only initializes once

  // ── react to layer visibility changes ─────────────────────────────
  // we use the map ref directly here instead of re-initializing

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return

    const vis = (id) => layerVisibility[id] ? 'visible' : 'none'

    if (map.getLayer('buildings-3d')) {
      map.setLayoutProperty('buildings-3d', 'visibility', vis('buildings'))
    }
    if (map.getLayer('fleet-circles')) {
      map.setLayoutProperty('fleet-circles', 'visibility', vis('fleet'))
      map.setLayoutProperty('fleet-glow', 'visibility', vis('fleet'))
    }
    if (map.getLayer('ndvi-fill')) {
      map.setLayoutProperty('ndvi-fill', 'visibility', vis('ndvi'))
    }

    // toggle 3D terrain mesh
    if (layerVisibility.terrain) {
      map.setTerrain({ source: 'terrain-dem', exaggeration: 2.0 })
    } else {
      map.setTerrain(null)
    }
  }, [layerVisibility])

  // ── react to extrusion multiplier changes ─────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    if (!map.getLayer('buildings-3d')) return

    map.setPaintProperty('buildings-3d', 'fill-extrusion-height', [
      '*',
      ['coalesce', ['get', 'height'], 10],
      extrusionMultiplier,
    ])
  }, [extrusionMultiplier])

  // ── react to fleet WS updates ─────────────────────────────────────
  // TODO: debounce this — it fires on every WS message which is fine for now
  //       but could cause jank if the server sends very high-frequency updates
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current || !lastFleetUpdate) return

    const src = map.getSource('fleet')
    if (!src) return

    src.setData({
      type: 'FeatureCollection',
      features: lastFleetUpdate.features || [],
    })
  }, [lastFleetUpdate])

  // ── react to individual building WS updates ───────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current || !lastBuildingUpdate) return

    const src = map.getSource('buildings')
    if (!src) return

    const updatedFeatures = lastBuildingUpdate.features
    if (!updatedFeatures?.length) return

    const currentData = src._data || { type: 'FeatureCollection', features: [] }
    const patches = new Map(
      updatedFeatures.map(f => [f.properties?.featureId, f])
    )

    const patchedFeatures = currentData.features.map(f =>
      patches.has(f.properties?.featureId) ? patches.get(f.properties.featureId) : f
    )

    src.setData({
      ...currentData,
      features: patchedFeatures,
    })
  }, [lastBuildingUpdate])

  return (
    <div
      ref={mapContainerRef}
      id="map-container"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
