// useOGCData.js — hook for fetching from our OGC API Features backend
//
// I thought about using react-query for this but it felt like overkill
// for a dashboard that only has a few collection endpoints. keeping it simple.
//
// polling every 30s for "slow" data (buildings don't move around)
// fleet gets real-time updates via WS in useLiveUpdates instead

import { useState, useEffect, useCallback, useRef } from 'react'
import { apiUrl } from '../utils/apiConfig'

const POLL_INTERVAL = 30_000 // 30 seconds feels right for non-fleet data

export function useOGCData(collection, params = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)
  const mountedRef = useRef(true)

  // build query string from params object
  const buildUrl = useCallback(() => {
    const qs = new URLSearchParams(params).toString()
    return apiUrl(`/api/collections/${collection}/items${qs ? `?${qs}` : ''}`)
  }, [collection, JSON.stringify(params)]) // stringify to do deep comparison

  const fetchData = useCallback(async () => {
    // don't bother if unmounted
    if (!mountedRef.current) return

    try {
      const url = buildUrl()
      const res = await fetch(url)

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`)
      }

      const json = await res.json()

      if (mountedRef.current) {
        setData(json)
        setError(null)
        setLoading(false)
      }
    } catch (err) {
      // network errors happen, especially in dev when backend isn't running
      console.warn(`[useOGCData] fetch failed for ${collection}:`, err.message)
      if (mountedRef.current) {
        setError(err)
        setLoading(false)
      }
    }
  }, [buildUrl, collection])

  // kick off initial fetch + polling on mount
  useEffect(() => {
    mountedRef.current = true
    setLoading(true)

    fetchData()

    // poll every 30s — buildings/NDVI data doesn't change that fast
    timerRef.current = setInterval(fetchData, POLL_INTERVAL)

    return () => {
      mountedRef.current = false
      clearInterval(timerRef.current)
    }
  }, [fetchData])

  // expose a manual refetch so callers can trigger on demand
  const refetch = useCallback(() => {
    setLoading(true)
    fetchData()
  }, [fetchData])

  return { data, loading, error, refetch }
}
