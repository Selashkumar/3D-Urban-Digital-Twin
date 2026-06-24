import { useState, useEffect } from 'react'

export default function InitialLoader({ visible }) {
  const [stepIndex, setStepIndex] = useState(0)
  const [mounted, setMounted] = useState(true)
  const [fadeClass, setFadeClass] = useState('')

  const steps = [
    'Initializing Cesium 3D Engine',
    'Fetching OGC Feature Collections',
    'Downloading Terrain Data',
    'Building 3D Landmark Geometries',
    'Synthesizing Urban Digital Twin'
  ]

  useEffect(() => {
    if (!visible) {
      setFadeClass('fade-out')
      const timer = setTimeout(() => {
        setMounted(false)
      }, 500) // matches transition duration
      return () => clearTimeout(timer)
    } else {
      setMounted(true)
      setFadeClass('')
    }
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const interval = setInterval(() => {
      setStepIndex((prev) => (prev + 1) % steps.length)
    }, 1200)
    return () => clearInterval(interval)
  }, [visible])

  if (!mounted) return null

  return (
    <div className={`initial-loader-overlay ${fadeClass}`}>
      <div className="loader-content glass-panel">
        <div className="loader-visual">
          <svg className="loader-svg" viewBox="0 0 100 100">
            <defs>
              <linearGradient id="loader-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--accent-cyan)" />
                <stop offset="100%" stopColor="var(--accent-purple)" />
              </linearGradient>
            </defs>
            <circle className="bg-circle" cx="50" cy="50" r="42" />
            <circle className="progress-circle" cx="50" cy="50" r="42" />
          </svg>
          <div className="loader-logo">3D</div>
        </div>
        <div className="loader-title">3D Urban Twin</div>
        <div className="loader-step">{steps[stepIndex]}</div>
      </div>
    </div>
  )
}
