/*
  CesiumMap3D.jsx — Google Earth-style 3D world renderer
  
  Uses CesiumJS loaded from the public/cesium folder (copied from node_modules).
  We access it via window.Cesium to avoid Vite bundling issues with the large
  CesiumJS library that has WebWorkers and WASM modules.
  
  Camera modes:
  - ORBIT: Google Earth drag/zoom navigation (default)
  - WALK:  WASD + mouse look, first-person street exploration
  - FLYTHROUGH: cinematic automated tour of city landmarks
*/

import { useEffect, useRef, useState, memo } from 'react'
import { apiUrl } from '../utils/apiConfig'

// ── Cesium ion token ─────────────────────────────────────────────────────────
const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN || ''
const HAS_TOKEN = ION_TOKEN && ION_TOKEN !== 'your_cesium_ion_token_here'

// ── Constants ─────────────────────────────────────────────────────────────────
const CITY_CENTER = { lon: -73.9857, lat: 40.7484 }
const TRAIL_MAX = 12

const LANDMARKS = [
  { lon: -73.9857, lat: 40.7484, alt: 800, heading: 45,  pitch: -30 },
  { lon: -73.9855, lat: 40.7580, alt: 500, heading: -20, pitch: -35 },
  { lon: -73.9832, lat: 40.7536, alt: 400, heading: 180, pitch: -28 },
  { lon: -73.9754, lat: 40.7516, alt: 600, heading: 200, pitch: -25 },
  { lon: -73.9741, lat: 40.7669, alt: 700, heading: 90,  pitch: -20 },
]

const USE_COLORS_CSS = {
  commercial:  'rgba(26, 111, 255, 0.88)',
  residential: 'rgba(147, 51, 234, 0.88)',
  mixed:       'rgba(6, 182, 212, 0.88)',
  industrial:  'rgba(249, 115, 22, 0.88)',
  default:     'rgba(80, 100, 140, 0.75)',
}

const FLEET_COLORS = {
  truck:     '#f97316',
  bus:       '#22c55e',
  emergency: '#ef4444',
  delivery:  '#3b82f6',
  default:   '#8899cc',
}

const NDVI_COLOR_RAMP = [
  [-1.0, '#0a4fff'],
  [-0.1, '#334466'],
  [ 0.0, '#556677'],
  [ 0.2, '#8a8a00'],
  [ 0.4, '#d4b800'],
  [ 0.6, '#22c55e'],
  [ 0.8, '#15803d'],
  [ 1.0, '#052e16'],
]

function hexToRgb(hex) {
  const num = parseInt(hex.slice(1), 16)
  return [ (num >> 16) & 255, (num >> 8) & 255, num & 255 ]
}

function rgbToHex(r, g, b) {
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
}

function interpolateColor(color1, color2, factor) {
  const c1 = hexToRgb(color1)
  const c2 = hexToRgb(color2)
  const r = Math.round(c1[0] + factor * (c2[0] - c1[0]))
  const g = Math.round(c1[1] + factor * (c2[1] - c1[1]))
  const b = Math.round(c1[2] + factor * (c2[2] - c1[2]))
  return rgbToHex(r, g, b)
}

function getNDVIColor(val) {
  if (val <= -1.0) return NDVI_COLOR_RAMP[0][1]
  if (val >= 1.0) return NDVI_COLOR_RAMP[NDVI_COLOR_RAMP.length - 1][1]
  for (let i = 0; i < NDVI_COLOR_RAMP.length - 1; i++) {
    const [v1, c1] = NDVI_COLOR_RAMP[i]
    const [v2, c2] = NDVI_COLOR_RAMP[i + 1]
    if (val >= v1 && val <= v2) {
      const factor = (val - v1) / (v2 - v1)
      return interpolateColor(c1, c2, factor)
    }
  }
  return '#556677'
}

// ── Vehicle icon builder ──────────────────────────────────────────────────────
const iconCache = {}
function makeIcon(type, hex) {
  const k = `${type}_${hex}`
  if (iconCache[k]) return iconCache[k]
  const sz = 48
  const c = document.createElement('canvas')
  c.width = sz; c.height = sz
  const ctx = c.getContext('2d')

  ctx.shadowColor = hex; ctx.shadowBlur = 12
  ctx.beginPath()
  ctx.arc(sz/2, sz/2, sz/2-5, 0, Math.PI*2)
  ctx.fillStyle = hex; ctx.globalAlpha = 0.85; ctx.fill()

  ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.moveTo(sz/2, 7)
  ctx.lineTo(sz/2-6, sz-11)
  ctx.lineTo(sz/2+6, sz-11)
  ctx.closePath(); ctx.fill()

  return (iconCache[k] = c.toDataURL())
}

// ── Load CesiumJS from the public folder ──────────────────────────────────────
let cesiumLoading = null
function loadCesium() {
  if (window.Cesium) return Promise.resolve(window.Cesium)
  if (cesiumLoading) return cesiumLoading

  cesiumLoading = new Promise((resolve, reject) => {
    // Load CSS
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/cesium/Widgets/widgets.css'
    document.head.appendChild(link)

    // Load JS
    const script = document.createElement('script')
    script.src = '/cesium/Cesium.js'
    script.onload = () => {
      if (window.Cesium) {
        window.Cesium.buildModuleUrl.setBaseUrl('/cesium/')
        resolve(window.Cesium)
      } else {
        reject(new Error('Cesium not on window after script load'))
      }
    }
    script.onerror = reject
    document.head.appendChild(script)
  })
  return cesiumLoading
}

// ── Component ─────────────────────────────────────────────────────────────────
const CesiumMap3D = memo(function CesiumMap3D({
  layerVisibility,
  onBuildingClick,
  selectedBuilding,
  buildingInteractionEnabled,
  onMapReady,
}) {
  const [mapLoaded, setMapLoaded] = useState(false)
  const containerRef   = useRef(null)
  const viewerRef      = useRef(null)
  const CesiumRef      = useRef(null)  // window.Cesium once loaded
  const buildingsRef   = useRef(new Map())
  const allBuildingsDataRef = useRef([])
  const fleetRef       = useRef(new Map())
  const tilesetRef     = useRef(null)
  const selectedEntityRef = useRef(null)
  const googleTilesLoadedRef = useRef(false)

  const buildingInteractionEnabledRef = useRef(buildingInteractionEnabled)
  useEffect(() => {
    buildingInteractionEnabledRef.current = buildingInteractionEnabled
  }, [buildingInteractionEnabled])

  // ── INIT ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let viewer = null

    loadCesium().then(Cesium => {
      if (cancelled || !containerRef.current) return
      CesiumRef.current = Cesium

      if (HAS_TOKEN) Cesium.Ion.defaultAccessToken = ION_TOKEN

      // Optimize network request scheduling for Google Photorealistic 3D Tiles
      Cesium.RequestScheduler.requestsByServer["tile.googleapis.com:443"] = 18

      const esriProvider = new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        credit: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maximumLevel: 19,
      })

      viewer = new Cesium.Viewer(containerRef.current, {
        baseLayer:                 new Cesium.ImageryLayer(esriProvider),
        terrainProvider:           new Cesium.EllipsoidTerrainProvider(),
        animation:                 false,
        baseLayerPicker:           false,
        fullscreenButton:          false,
        geocoder:                  false,
        homeButton:                false,
        infoBox:                   false,
        sceneModePicker:           false,
        selectionIndicator:        false,
        timeline:                  false,
        navigationHelpButton:      false,
        shadows:                   false,
        requestRenderMode:         false,
        scene3DOnly:               true,
        skyBox:                    false,
        skyAtmosphere:             false,
        shouldAnimate:             true,
      })

      if (cancelled) { viewer.destroy(); return }

      viewerRef.current = viewer

      // Scene tweaks & performance optimization for zoom/scroll/high-DPI Macbook Retina screens
      viewer.resolutionScale = Math.min(1.0, window.devicePixelRatio || 1.0)
      viewer.scene.globe.maximumScreenSpaceError = 8.0 // Reduces terrain mesh grid detail for significant FPS gains
      viewer.scene.globe.loadingQueueThreshold = 20    // Keeps rendering smooth when loading maps/terrain
      viewer.scene.globe.tileCacheSize = 512           // Retain more tiles in cache
      
      viewer.scene.globe.enableLighting = false
      viewer.scene.fog.enabled = true
      viewer.scene.fog.density = 0.00008
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#f3f4f6')
      viewer.scene.globe.baseColor  = Cesium.Color.fromCssColorString('#ffffff')

      // Drape satellite imagery over 3D terrain mesh by default
      Cesium.createWorldTerrainAsync()
        .then(tp => {
          if (!cancelled && viewer) {
            viewer.terrainProvider = tp
          }
        })
        .catch(e => console.warn('[CesiumMap3D] Failed to load world terrain:', e.message))

      // ── World Imagery ──────────────────────────────────────────────────────
      if (HAS_TOKEN) {
        Cesium.createWorldImageryAsync()
          .then(provider => {
            if (!cancelled && viewer) {
              viewer.imageryLayers.removeAll()
              viewer.imageryLayers.addImageryProvider(provider)
            }
          })
          .catch(e => console.warn('Failed to load Bing World Imagery:', e))
      }

      // ── Cinematic fly-in ────────────────────────────────────────────────
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(CITY_CENTER.lon, CITY_CENTER.lat, 20000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
      })
      setTimeout(() => {
        if (cancelled || !viewerRef.current) return
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(CITY_CENTER.lon, CITY_CENTER.lat, 1600),
          orientation: {
            heading: Cesium.Math.toRadians(-15),
            pitch: Cesium.Math.toRadians(-35),
            roll: 0,
          },
          duration: 4,
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        })
      }, 700)

      // ── Google Photorealistic 3D Tiles & OSM Fallback ───────────────────
      Cesium.createGooglePhotorealistic3DTileset()
        .then(tileset => {
          if (!cancelled && viewer) {
            // Apply level-of-detail and memory performance tuning
            tileset.maximumScreenSpaceError = 32  // Default is 16; increasing this reduces texture/mesh detail slightly for much higher FPS
            tileset.maximumMemoryUsage = 2048      // Cap memory utilization to 2048MB to prevent cache thrashing
            tileset.progressiveResolutionHeightFraction = 0.5 // Renders lower quality during quick camera moves/zooms
            tileset.foveatedScreenSpaceError = true
            tileset.foveatedConeSize = 0.1
            tileset.dynamicScreenSpaceError = true // Dynamically adjust level of detail based on distance

            viewer.scene.primitives.add(tileset)
            tilesetRef.current = tileset
            tileset.show = layerVisibility?.structures !== false
            googleTilesLoadedRef.current = true

            // Hide the static database building polygons since we have realistic tiles!
            buildingsRef.current.forEach(ent => {
              if (ent.polygon) ent.polygon.show = false
            })

            // Listen to initialTilesLoaded to resolve loader
            tileset.initialTilesLoaded.addEventListener(() => {
              console.log('[CesiumMap3D] Google Tileset initial tiles loaded')
              if (viewer._resolveTilesetLoad) viewer._resolveTilesetLoad()
            })

            console.log('[CesiumMap3D] Google Photorealistic 3D Tiles loaded successfully')
          }
        })
        .catch(err => {
          console.warn('[CesiumMap3D] Google Photorealistic 3D Tiles failed, trying OSM Buildings:', err)
          googleTilesLoadedRef.current = false

          // Show database building polygons as fallback structures!
          buildingsRef.current.forEach(ent => {
            if (ent.polygon) ent.polygon.show = layerVisibility?.buildings !== false
          })

          Cesium.Cesium3DTileset.fromIonAssetId(96188)
            .then(t => {
              if (cancelled || !viewerRef.current) return
              t.maximumScreenSpaceError = 32  // Performance optimization for OSM fallback tileset
              t.maximumMemoryUsage = 2048
              t.dynamicScreenSpaceError = true
              
              viewer.scene.primitives.add(t)
              tilesetRef.current = t
              t.show = layerVisibility?.structures !== false
              t.style = new Cesium.Cesium3DTileStyle({
                color: "color('white')",
              })

              t.initialTilesLoaded.addEventListener(() => {
                console.log('[CesiumMap3D] OSM Fallback initial tiles loaded')
                if (viewer._resolveTilesetLoad) viewer._resolveTilesetLoad()
              })

              console.log('[CesiumMap3D] OSM Buildings fallback loaded successfully')
            })
            .catch(e => {
              console.warn('[CesiumMap3D] OSM Buildings fallback failed:', e)
              if (viewer._resolveTilesetLoad) viewer._resolveTilesetLoad()
            })
        })

      // ── Click: select building ─────────────────────────────────────────
      const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
      clickHandler.setInputAction(e => {
        if (!buildingInteractionEnabledRef.current) return
        const picked = viewer.scene.pick(e.position)
        
        // 1. If we clicked one of our floating landmark labels
        if (picked?.id?._buildingData) {
          onBuildingClick && onBuildingClick(picked.id._buildingData)
          return
        }

        // 2. Perform spatial intersection to find the closest database building
        const cartesian = viewer.scene.pickPosition(e.position) || viewer.camera.pickEllipsoid(e.position)
        if (cartesian) {
          const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
          const clickLon = Cesium.Math.toDegrees(cartographic.longitude)
          const clickLat = Cesium.Math.toDegrees(cartographic.latitude)

          // Find the closest building from allBuildingsDataRef
          let closest = null
          let minDist = 0.0006 // ~60 meters in degrees
          
          allBuildingsDataRef.current.forEach(f => {
            const geom = f.geometry
            if (!geom || geom.type !== 'Polygon') return
            
            const ring = geom.coordinates[0]
            const clon = ring.reduce((s, pt) => s + pt[0], 0) / ring.length
            const clat = ring.reduce((s, pt) => s + pt[1], 0) / ring.length
            
            const dist = Math.sqrt((clickLon - clon) ** 2 + (clickLat - clat) ** 2)
            if (dist < minDist) {
              minDist = dist
              closest = f
            }
          })

          if (closest) {
            onBuildingClick && onBuildingClick({
              properties: closest.properties,
              geometry: closest.geometry,
            })
            return
          }
        }

        onBuildingClick && onBuildingClick(null)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

      // ── Double-click: fly to location ──────────────────────────────────
      clickHandler.setInputAction(e => {
        const cart = viewer.camera.pickEllipsoid(e.position)
        if (!cart) return
        const cg = Cesium.Cartographic.fromCartesian(cart)
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromRadians(cg.longitude, cg.latitude, 350),
          orientation: { heading: viewer.camera.heading, pitch: Cesium.Math.toRadians(-30), roll: 0 },
          duration: 2,
        })
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

      // ── A promise that resolves when the 3D structures tileset loads its initial tiles (safety timeout of 10s) ──
      const tilesetLoadPromise = new Promise((resolve) => {
        let resolved = false
        const safetyTimeout = setTimeout(() => {
          if (!resolved) {
            console.log('[CesiumMap3D] Tileset load timed out (safety fallback)')
            resolved = true
            resolve()
          }
        }, 10000)

        viewer._resolveTilesetLoad = () => {
          if (!resolved) {
            clearTimeout(safetyTimeout)
            resolved = true
            resolve()
          }
        }
      })

      // ── Load data ──────────────────────────────────────────────────────
      Promise.all([
        fetchBuildings(viewer, Cesium),
        fetchFleet(viewer, Cesium),
        tilesetLoadPromise
      ]).then(() => {
        if (!cancelled) {
          setMapLoaded(true)
          onMapReady && onMapReady()
        }
      }).catch(err => {
        console.warn('[CesiumMap3D] Initial data load error:', err)
        if (!cancelled) {
          setMapLoaded(true)
          onMapReady && onMapReady()
        }
      })

    }).catch(err => console.error('[CesiumMap3D] Failed to load Cesium:', err))

    return () => {
      cancelled = true
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
    }
  }, [])

  async function fetchBuildings(viewer, Cesium) {
    try {
      const res = await fetch(apiUrl('/api/collections/buildings/items?bbox=-74.02,40.70,-73.93,40.78&limit=500'))
      if (!res.ok) return
      const { features = [] } = await res.json()
      if (!viewerRef.current || viewerRef.current.isDestroyed()) return

      allBuildingsDataRef.current = features // Save all database buildings for picking lookup
      features.forEach(f => {
        const props = f.properties || {}
        const geom  = f.geometry
        if (!geom || geom.type !== 'Polygon') return

        // Skip unnamed/generic buildings on the map to prevent CPU performance lag.
        if (!props.name || props.name.trim().length === 0) return

        const h       = props.height || 10
        const ring    = geom.coordinates[0]

        // Compute centroid for floating labels
        const clon = ring.reduce((s, pt) => s + pt[0], 0) / ring.length
        const clat = ring.reduce((s, pt) => s + pt[1], 0) / ring.length

        const pos = ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 0.5))

        const entityConfig = {
          position: Cesium.Cartesian3.fromDegrees(clon, clat, h + 10),
          /*
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(pos),
            extrudedHeight: h,
            material: color,
            outline: true,
            outlineColor: outlineColor,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            show: !googleTilesLoadedRef.current && (layerVisibility?.buildings !== false),
          },
          */
          label: {
            text: props.name,
            font: 'bold 11px Inter, system-ui, sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#1f2937'),
            outlineColor: Cesium.Color.fromCssColorString('#ffffff'),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: 1000,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 1600.0), // hide when zoomed out
            pixelOffset: new Cesium.Cartesian2(0, -5),
          }
        }

        const entity = viewer.entities.add(entityConfig)

        entity._buildingData = { properties: props, geometry: geom }
        buildingsRef.current.set(String(props.featureId || f.id), entity)
      })
    } catch (e) {
      console.warn('[CesiumMap3D] Buildings:', e.message)
    }
  }

  // ── Fetch & render fleet ───────────────────────────────────────────────────
  async function fetchFleet(viewer, Cesium) {
    try {
      const res = await fetch(apiUrl('/api/collections/fleet/items'))
      if (!res.ok) return
      const { features = [] } = await res.json()
      if (!viewerRef.current || viewerRef.current.isDestroyed()) return

      features.forEach(f => {
        const props = f.properties || {}
        const [lon, lat] = f.geometry?.coordinates || [null, null]
        if (lon == null) return

        const hex = FLEET_COLORS[props.type] || FLEET_COLORS.default

        const entity = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 15),
          billboard: {
            image: makeIcon(props.type, hex),
            width: 36, height: 36,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            heightReference: Cesium.HeightReference.NONE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            rotation: Cesium.Math.toRadians(-(props.heading || 0)),
            alignedAxis: Cesium.Cartesian3.UNIT_Z,
          },
        })

        entity._vehicleData = props
        fleetRef.current.set(String(props.vehicle_id || f.id), entity)
      })
    } catch (e) {
      console.warn('[CesiumMap3D] Fleet:', e.message)
    }
  }

  // ── WebSocket Updates via Custom Events (avoiding React re-renders) ──────
  useEffect(() => {
    if (!mapLoaded) return

    const handleFleetUpdate = (e) => {
      const viewer = viewerRef.current
      const Cesium = CesiumRef.current
      if (!viewer || !Cesium || !e.detail) return

      e.detail.forEach(f => {
        const props = f.properties || {}
        const [lon, lat] = f.geometry?.coordinates || [null, null]
        if (lon == null) return

        const vid = String(props.vehicle_id || f.id)
        const ent = fleetRef.current.get(vid)
        if (!ent) return

        const targetPos = Cesium.Cartesian3.fromDegrees(lon, lat, 15)

        // ── Smooth vehicle position interpolation ──
        let property = ent.position
        if (!(property instanceof Cesium.SampledPositionProperty)) {
          property = new Cesium.SampledPositionProperty()
          property.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD
          property.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD
          property.setInterpolationOptions({
            interpolationDegree: 1,
            interpolationAlgorithm: Cesium.LinearApproximation,
          })
          ent.position = property
        }

        // Sim updates every 3 seconds; project target 3s in the future
        const time = Cesium.JulianDate.addSeconds(viewer.clock.currentTime, 3, new Cesium.JulianDate())
        property.addSample(time, targetPos)

        // Prevent memory growth by keeping samples clean
        const thresholdTime = Cesium.JulianDate.addSeconds(viewer.clock.currentTime, -12, new Cesium.JulianDate())
        property.removeSamplesBeforeDate(thresholdTime)

        // ── Billboard rotation interpolation ──
        if (ent.billboard) {
          const rad = Cesium.Math.toRadians(-(props.heading || 0))
          let rotProperty = ent.billboard.rotation
          if (!(rotProperty instanceof Cesium.SampledProperty)) {
            rotProperty = new Cesium.SampledProperty(Number)
            ent.billboard.rotation = rotProperty
          }
          rotProperty.addSample(time, rad)
          rotProperty.removeSamplesBeforeDate(thresholdTime)
        }
      })
    }

    const handleBuildingUpdate = (e) => {
      const viewer = viewerRef.current
      const Cesium = CesiumRef.current
      if (!viewer || !Cesium || !e.detail) return

      e.detail.forEach(f => {
        const props = f.properties || {}
        const fid = String(props.featureId || f.id)
        const ent = buildingsRef.current.get(fid)
        if (!ent) return

        const h = props.height || 10

        // Update floating label position height
        if (ent.position && ent._buildingData?.geometry?.coordinates) {
          const ring = ent._buildingData.geometry.coordinates[0]
          const clon = ring.reduce((s, pt) => s + pt[0], 0) / ring.length
          const clat = ring.reduce((s, pt) => s + pt[1], 0) / ring.length
          const targetPos = Cesium.Cartesian3.fromDegrees(clon, clat, h + 10)
          
          if (ent.position instanceof Cesium.SampledPositionProperty) {
            const time = Cesium.JulianDate.addSeconds(viewer.clock.currentTime, 1, new Cesium.JulianDate())
            ent.position.addSample(time, targetPos)
          } else if (typeof ent.position.setValue === 'function') {
            ent.position.setValue(targetPos)
          } else {
            ent.position = new Cesium.ConstantPositionProperty(targetPos)
          }
        }

        // Update polygon extrudedHeight
        if (ent.polygon) {
          if (ent.polygon.extrudedHeight && typeof ent.polygon.extrudedHeight.setValue === 'function') {
            ent.polygon.extrudedHeight.setValue(h)
          } else {
            ent.polygon.extrudedHeight = new Cesium.ConstantProperty(h)
          }
        }

        ent._buildingData = { ...ent._buildingData, properties: props }
      })
    }

    window.addEventListener('fleet-update', handleFleetUpdate)
    window.addEventListener('building-update', handleBuildingUpdate)

    return () => {
      window.removeEventListener('fleet-update', handleFleetUpdate)
      window.removeEventListener('building-update', handleBuildingUpdate)
    }
  }, [mapLoaded])

  // ── Layer visibility ──────────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const ss = layerVisibility?.structures !== false
    const sb = layerVisibility?.buildings !== false
    const sf = layerVisibility?.fleet !== false
    buildingsRef.current.forEach(e => {
      e.show = sb
      if (e.polygon) {
        e.polygon.show = sb && !googleTilesLoadedRef.current
      }
    })
    if (selectedEntityRef.current) {
      selectedEntityRef.current.show = sb
    }
    fleetRef.current.forEach(e => { e.show = sf })

    if (tilesetRef.current) {
      tilesetRef.current.show = ss
    }
  }, [layerVisibility])

  // ── Satellite Imagery Layer Toggle ─────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current
    const Cesium = CesiumRef.current
    if (!mapLoaded || !viewer || !Cesium) return

    viewer.imageryLayers.removeAll()

    const isSentinel = layerVisibility?.imagery === 'sentinel'
    const providerUrl = isSentinel
      ? 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'
      : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

    const creditText = isSentinel
      ? 'Sentinel-2 Cloudless © EOX IT Services GmbH (Contains modified Copernicus Sentinel data)'
      : 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'

    const maxLevel = isSentinel ? 14 : 19

    const provider = new Cesium.UrlTemplateImageryProvider({
      url: providerUrl,
      credit: creditText,
      maximumLevel: maxLevel,
    })

    viewer.imageryLayers.addImageryProvider(provider)
  }, [mapLoaded, layerVisibility?.imagery])

  // ── Highlight selected building ────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current
    const Cesium = CesiumRef.current
    if (!viewer || !Cesium) return

    // 1. Clean up previous highlight style / temporary entity
    if (selectedEntityRef.current) {
      const prevEnt = selectedEntityRef.current
      if (prevEnt._isTemp) {
        viewer.entities.remove(prevEnt)
      } else {
        // Restore original landmark styling
        const props = prevEnt._buildingData?.properties || {}
        const isConstruction = props.status === 'construction'
        const color = isConstruction
          ? Cesium.Color.fromCssColorString('rgba(249, 115, 22, 0.35)')
          : Cesium.Color.fromCssColorString('rgba(235, 240, 250, 0.85)')
        const outlineColor = isConstruction
          ? Cesium.Color.fromCssColorString('#f97316')
          : Cesium.Color.fromCssColorString('#475569')

        if (prevEnt.polygon) {
          prevEnt.polygon.material = color
          prevEnt.polygon.outlineColor = outlineColor
        }
      }
      selectedEntityRef.current = null
    }

    if (!selectedBuilding) return

    // 2. Look up if the selected building is an existing landmark entity
    const props = selectedBuilding.properties || {}
    const fid = String(props.featureId || selectedBuilding.id)
    const existingEnt = buildingsRef.current.get(fid)

    if (existingEnt && existingEnt.polygon) {
      // Highlight existing landmark entity in neon cyan
      existingEnt.polygon.material = Cesium.Color.fromCssColorString('rgba(6, 182, 212, 0.75)')
      existingEnt.polygon.outlineColor = Cesium.Color.fromCssColorString('#06b6d4')
      selectedEntityRef.current = existingEnt
    } else if (selectedBuilding.geometry?.coordinates) {
      // If it's a generic building, dynamically create a temporary neon cyan highlight polygon
      const ring = selectedBuilding.geometry.coordinates[0]
      const pos = ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 0.5))
      const h = selectedBuilding.properties?.height || 10

      const tempEnt = viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(pos),
          extrudedHeight: h,
          material: Cesium.Color.fromCssColorString('rgba(6, 182, 212, 0.75)'),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#06b6d4'),
          outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        },
        show: true,
      })

      tempEnt._isTemp = true
      tempEnt._buildingData = selectedBuilding
      selectedEntityRef.current = tempEnt
    }
  }, [selectedBuilding])

  return (
    <div
      ref={containerRef}
      id="cesium-container"
      style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
    />
  )
})

export default CesiumMap3D

function pulseEntity(entity, Cesium) {
  if (!entity?.polygon) return
  const orig = entity.polygon.material
  entity.polygon.material = Cesium.Color.WHITE.withAlpha(0.95)
  setTimeout(() => { if (entity.polygon) entity.polygon.material = orig }, 450)
}
