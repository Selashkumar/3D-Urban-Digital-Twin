import { useState, useEffect, useRef, useCallback } from 'react'
import { wsUrl } from '../utils/apiConfig'

const INITIAL_BACKOFF = 1000
const MAX_BACKOFF = 30_000

export function useLiveUpdates(enabled = true) {
  const [status, setStatus] = useState('connecting')
  const [lastFleetUpdate, setLastFleetUpdate] = useState(null)
  const [lastBuildingUpdate, setLastBuildingUpdate] = useState(null)

  const wsRef = useRef(null)
  const backoffRef = useRef(INITIAL_BACKOFF)
  const reconnectTimerRef = useRef(null)
  const mountedRef = useRef(true)

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    clearTimeout(reconnectTimerRef.current)
    setStatus('connecting')

    const url = wsUrl('/ws')
    console.log(`Connecting to WebSocket at: ${url}`)
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      console.log(`WebSocket connected successfully to: ${url}`)
      setStatus('connected')
      backoffRef.current = INITIAL_BACKOFF
    }

    ws.onmessage = (event) => {
      if (!mountedRef.current) return

      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      switch (msg.type) {
        case 'fleet_update':
          setLastFleetUpdate({ features: msg.features, ts: Date.now() })
          break

        case 'building_update':
          setLastBuildingUpdate({ features: msg.features || [], ts: Date.now() })
          break

        default:
          break
      }
    }

    ws.onclose = (event) => {
      if (!mountedRef.current) return
      console.log(`WebSocket disconnected from: ${url}. Code: ${event.code}, Reason: ${event.reason || 'none'}`)
      setStatus('disconnected')

      reconnectTimerRef.current = setTimeout(() => {
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF)
        connect()
      }, backoffRef.current)
    }

    ws.onerror = (err) => {
      console.error(`WebSocket error for URL ${url}:`, err)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setStatus('disconnected')
      if (wsRef.current) {
        wsRef.current.close(1000, 'disabled by user')
        wsRef.current = null
      }
      return
    }

    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false
      clearTimeout(reconnectTimerRef.current)
      if (wsRef.current) {
        wsRef.current.close(1000, 'component unmounting')
        wsRef.current = null
      }
    }
  }, [connect, enabled])

  return { status, lastFleetUpdate, lastBuildingUpdate }
}
