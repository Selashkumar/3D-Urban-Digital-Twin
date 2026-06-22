// Shared API / WebSocket base URLs for dev (Vite proxy) and production (Azure SWA)

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''
const WS_BASE = import.meta.env.VITE_WS_BASE_URL || ''

export function apiUrl(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${normalized}`
}

export function wsUrl(path = '/ws') {
  const normalized = path.startsWith('/') ? path : `/${path}`

  if (WS_BASE) {
    return `${WS_BASE}${normalized}`
  }

  // dev fallback to bypass flaky vite websocket proxy
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `ws://${window.location.hostname}:3002${normalized}`
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${normalized}`
}
