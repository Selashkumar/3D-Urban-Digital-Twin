// BuildingPopup.jsx — shows detail when a building is clicked on the map
//
// decided to make this a fixed React overlay instead of using MapLibre's built-in Popup
// mainly because styling MapLibre popups to match the glassmorphism theme is a pain
// and we lose a lot of control. this way we own the whole thing.
//
// position: bottom-right, so it doesn't cover the sidebar

import { useState, useEffect, useRef } from 'react'

// quick count-up animation for the height number
// felt like a nice touch — shows that it's "measuring" the building
function useCountUp(target, duration = 800) {
  const [current, setCurrent] = useState(0)
  const rafRef = useRef(null)

  useEffect(() => {
    if (target == null) return
    const start = Date.now()
    const from = 0

    function tick() {
      const elapsed = Date.now() - start
      const progress = Math.min(elapsed / duration, 1)
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3)
      setCurrent(Math.round(from + (target - from) * eased))

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, duration])

  return current
}

const STATUS_CONFIG = {
  operational:  { label: 'Operational',  color: 'var(--accent-green)',  pulse: false },
  construction: { label: 'Construction', color: 'var(--accent-orange)', pulse: true },
  planned:      { label: 'Planned',      color: 'var(--accent-purple)', pulse: true },
}

export default function BuildingPopup({ feature, onClose }) {
  // Cesium passes { properties, geometry } directly; MapLibre passes a GeoJSON feature
  const props = feature?.properties || feature?.feature?.properties || {}
  const heightAnimated = useCountUp(props.height, 600)
  const [visible, setVisible] = useState(false)

  // fade in on mount
  useEffect(() => {
    if (feature) {
      // tiny delay so the CSS transition fires
      const t = setTimeout(() => setVisible(true), 20)
      return () => clearTimeout(t)
    } else {
      setVisible(false)
    }
  }, [feature])

  if (!feature) return null

  const statusInfo = STATUS_CONFIG[props.status] || {
    label: props.status || 'Unknown',
    color: 'var(--text-muted)',
    pulse: false,
  }

  // NDVI score color — green if high, orange if low
  const ndviColor = props.ndvi_score > 0.4
    ? 'var(--accent-green)'
    : props.ndvi_score > 0.1
      ? '#d4b800'
      : 'var(--text-muted)'

  return (
    <div
      className="building-popup-overlay"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(12px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        {/* top accent bar — color matches use_type */}
        <div style={{
          height: 3,
          background: USE_TYPE_GRADIENT[props.use_type] || 'var(--bg-glass)',
        }} />

        <div style={{ padding: '14px 16px' }}>
          {/* header row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--text-primary)',
                margin: '0 0 4px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {props.name || props.building_id || 'Unnamed Building'}
              </h3>
              <span className={`use-badge ${props.use_type || 'default'}`}>
                {props.use_type || 'unknown'}
              </span>
            </div>

            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '2px 4px',
                fontSize: 16,
                lineHeight: 1,
                borderRadius: 4,
                transition: 'color 0.15s',
                flexShrink: 0,
              }}
              onMouseEnter={e => e.target.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.target.style.color = 'var(--text-muted)'}
            >
              ×
            </button>
          </div>

          {/* stats grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px 12px',
            marginBottom: 12,
          }}>
            <StatCell
              label="Height"
              value={`${heightAnimated}m`}
              color="var(--accent-cyan)"
            />
            <StatCell
              label="Floors"
              value={props.floors ?? '—'}
              color="var(--text-secondary)"
            />
            <StatCell
              label="Year Built"
              value={props.year_built ?? '—'}
              color="var(--text-secondary)"
            />
            <StatCell
              label="Material"
              value={props.material ?? '—'}
              color="var(--text-secondary)"
            />
          </div>

          <div className="divider" style={{ margin: '10px 0' }} />

          {/* status row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Status</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                className={`status-dot ${statusInfo.pulse ? 'connecting' : 'connected'}`}
                style={{ background: statusInfo.color }}
              />
              <span style={{ fontSize: 12, color: statusInfo.color, fontWeight: 500 }}>
                {statusInfo.label}
              </span>
            </div>
          </div>

          {/* NDVI score */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>NDVI Score</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 60,
                height: 4,
                borderRadius: 2,
                background: 'var(--border-glass)',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${Math.max(0, Math.min(100, (props.ndvi_score || 0) * 100))}%`,
                  height: '100%',
                  background: ndviColor,
                  borderRadius: 2,
                  transition: 'width 0.6s ease',
                }} />
              </div>
              <span className="mono" style={{ fontSize: 12, color: ndviColor }}>
                {props.ndvi_score != null ? props.ndvi_score.toFixed(3) : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// gradient per use_type for the accent bar at top of popup
const USE_TYPE_GRADIENT = {
  commercial:  'linear-gradient(90deg, #1a6fff, #0a4fff)',
  residential: 'linear-gradient(90deg, #9333ea, #7c3aed)',
  mixed:       'linear-gradient(90deg, #06b6d4, #0891b2)',
  industrial:  'linear-gradient(90deg, #f97316, #ea580c)',
}

function StatCell({ label, value, color }) {
  return (
    <div>
      <div style={{
        fontSize: 9,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 2,
      }}>
        {label}
      </div>
      <div className="mono" style={{
        fontSize: 14,
        fontWeight: 500,
        color: color || 'var(--text-primary)',
      }}>
        {value}
      </div>
    </div>
  )
}
