// mapConfig.js — all the map constants and style stuff lives here
// pulled this out of Map3D.jsx when it started getting long

export const MAP_CENTER = [-73.9857, 40.7484]
export const MAP_ZOOM = 14.5
export const MAP_PITCH = 55
export const MAP_BEARING = -15

export const CITY_BOUNDS = [
  [-74.02, 40.70],
  [-73.93, 40.78],
]

// bbox string for OGC API queries covering the metropolitan study area
export const CITY_BBOX = '-74.02,40.70,-73.93,40.78'

// building use type → color mapping
// using these same hex values in the MapLibre layer paint + the legend component
export const USE_TYPE_COLORS = {
  commercial:  '#1a6fff',
  residential: '#9333ea',
  mixed:       '#06b6d4',
  industrial:  '#f97316',
  default:     '#556688',
}

export const FLEET_TYPE_COLORS = {
  truck:     '#f97316',
  bus:       '#22c55e',
  emergency: '#ef4444',
  delivery:  '#3b82f6',
  default:   '#8899cc',
}

// the NDVI color ramp — used both in the legend and in the MapLibre interpolate expression
// negative values are water/non-veg (blue), 0 is bare soil (gray), higher = more vegetation
export const NDVI_COLOR_RAMP = [
  [-1.0, '#0a4fff'],
  [-0.1, '#334466'],
  [ 0.0, '#556677'],
  [ 0.2, '#8a8a00'],
  [ 0.4, '#d4b800'],
  [ 0.6, '#22c55e'],
  [ 0.8, '#15803d'],
  [ 1.0, '#052e16'],
]

// builds the maplibre interpolate expression for NDVI fill color
// call this once and plug it into the paint property
export function buildNDVIColorExpression() {
  const stops = NDVI_COLOR_RAMP.flatMap(([val, color]) => [val, color])
  return [
    'interpolate',
    ['linear'],
    ['get', 'ndvi_value'],
    ...stops,
  ]
}

// the custom dark map style — based on a minimal tile setup
// I tried using a third-party dark style but the tile servers were flaky
// so building a custom style with demotiles gives us more control anyway
export function buildMapStyle() {
  return {
    version: 8,
    name: 'Urban Twin Dark',
    fog: {
      color: '#060912',
      'high-color': '#0a0e1a',
      'space-color': '#000008',
      'horizon-blend': 0.04,
      'star-intensity': 0.15,
    },
    // use demotiles for the base vector tiles — free and reliable
    sources: {
      'demotiles': {
        type: 'vector',
        url: 'https://demotiles.maplibre.org/tiles/tiles.json',
      },
      'satellite': {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
      },
      'terrain-dem': {
        type: 'raster-dem',
        url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
        tileSize: 256
      }
    },
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    layers: [
      // --- background ---
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#060912',
        },
      },
      // --- satellite base ---
      {
        id: 'satellite-base',
        type: 'raster',
        source: 'satellite',
        paint: {
          'raster-opacity': 0.85,
        },
      },

      // --- water ---
      {
        id: 'water',
        type: 'fill',
        source: 'demotiles',
        'source-layer': 'water',
        paint: {
          'fill-color': '#0a1628',
          'fill-opacity': 1,
        },
      },

      // --- land ---
      {
        id: 'land',
        type: 'fill',
        source: 'demotiles',
        'source-layer': 'land',
        paint: {
          'fill-color': '#0d1321',
        },
      },

      // --- coastlines ---
      {
        id: 'coastline',
        type: 'line',
        source: 'demotiles',
        'source-layer': 'coastlines',
        paint: {
          'line-color': '#1a2a44',
          'line-width': 1,
        },
      },

      // --- countries borders (subtle) ---
      {
        id: 'countries',
        type: 'line',
        source: 'demotiles',
        'source-layer': 'countries',
        paint: {
          'line-color': '#1a2a44',
          'line-width': 0.5,
          'line-opacity': 0.5,
        },
      },

      // --- place labels — kept minimal, just major cities ---
      {
        id: 'places',
        type: 'symbol',
        source: 'demotiles',
        'source-layer': 'places',
        filter: ['>=', ['get', 'population'], 100000],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'text-anchor': 'center',
        },
        paint: {
          'text-color': '#445577',
          'text-halo-color': '#060912',
          'text-halo-width': 1,
        },
      },
    ],

    // set the sky/atmosphere for that depth feel
    sky: {
      'sky-color': '#0a0e1a',
      'sky-horizon-blend': 0.5,
      'horizon-color': '#111827',
      'horizon-fog-blend': 0.5,
      'fog-color': '#060912',
      'fog-ground-blend': 0.5,
    },
  }
}
