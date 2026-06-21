// StatsBar.jsx — the thin strip across the top of the screen
// shows the high-level numbers at a glance — quick health check without opening the sidebar

import { useMemo } from 'react'

export default function StatsBar({ buildings, fleet, connectionStatus }) {
  // crunch the numbers from the feature collections
  const stats = useMemo(() => {
    if (!buildings && !fleet) return null

    const allBuildings = buildings?.features || []
    const allFleet = fleet?.features || []

    const underConstruction = allBuildings.filter(
      f => f.properties?.status === 'construction'
    ).length

    const activeVehicles = allFleet.filter(
      f => f.properties?.status === 'moving'
    ).length

    // average NDVI across all buildings that have a score
    const ndviValues = allBuildings
      .map(f => f.properties?.ndvi_score)
      .filter(v => v != null && !isNaN(v))
    const avgNDVI = ndviValues.length > 0
      ? (ndviValues.reduce((a, b) => a + b, 0) / ndviValues.length).toFixed(3)
      : '—'

    return {
      total: allBuildings.length,
      underConstruction,
      activeVehicles,
      totalFleet: allFleet.length,
      avgNDVI,
    }
  }, [buildings, fleet])

  const now = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const statusColor = {
    connected: 'var(--accent-green)',
    connecting: 'var(--accent-orange)',
    disconnected: 'var(--accent-red)',
  }[connectionStatus] || 'var(--text-muted)'

  return (
    <div className="stats-bar">
      {/* brand mark — small but present */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginRight: 24,
        flexShrink: 0,
      }}>
        <div style={{
          width: 20,
          height: 20,
          borderRadius: 4,
          background: 'linear-gradient(135deg, var(--accent-cyan), var(--accent-purple))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          color: '#fff',
        }}>
          3D
        </div>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}>
          3D Urban Twin
        </span>
      </div>

      {/* separator */}
      <div style={{ width: 1, height: 20, background: 'var(--border-glass)', marginRight: 24, flexShrink: 0 }} />

      {/* stat items */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        flex: 1,
        overflow: 'hidden',
      }}>
        <StatItem
          label="Buildings"
          value={stats?.total ?? '—'}
          color="var(--accent-cyan)"
        />
        <StatDivider />
        <StatItem
          label="Construction"
          value={stats?.underConstruction ?? '—'}
          color="var(--accent-orange)"
        />
        <StatDivider />
        <StatItem
          label="Fleet Active"
          value={stats ? `${stats.activeVehicles}/${stats.totalFleet}` : '—'}
          color="var(--accent-green)"
        />
        <StatDivider />
        <StatItem
          label="Avg NDVI"
          value={stats?.avgNDVI ?? '—'}
          color="var(--accent-teal)"
        />
        <StatDivider />
        <StatItem
          label="Updated"
          value={now}
          color="var(--text-secondary)"
        />
      </div>

      {/* WS connection status — far right */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginLeft: 'auto',
        flexShrink: 0,
        paddingLeft: 16,
      }}>
        <div style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: statusColor,
          animation: connectionStatus === 'connected' ? 'pulse-dot 2s ease-in-out infinite' : 'none',
        }} />
        <span style={{
          fontSize: 10,
          color: statusColor,
          fontWeight: 500,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {connectionStatus}
        </span>
      </div>
    </div>
  )
}

function StatItem({ label, value }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      padding: '0 16px',
      gap: 1,
    }}>
      <span style={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        lineHeight: 1,
      }}>
        {label}
      </span>
      <span className="mono" style={{
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--text-primary)',
        lineHeight: 1,
      }}>
        {value}
      </span>
    </div>
  )
}

function StatDivider() {
  return (
    <div style={{
      width: 1,
      height: 28,
      background: 'var(--border-glass)',
      flexShrink: 0,
    }} />
  )
}
