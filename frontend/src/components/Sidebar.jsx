import React from 'react'
import LayerControls from './LayerControls'
import FleetPanel from './FleetPanel'

export default function Sidebar({
  isOpen,
  setIsOpen,
  wsStatus,
  layerVisibility,
  onLayerVisibilityChange,
  fleetData,
}) {
  const statusColor = wsStatus === 'connected' ? 'var(--accent-green)' :
                      wsStatus === 'connecting' ? 'var(--accent-orange)' : 'var(--accent-red)'

  return (
    <>
      {!isOpen && (
        <button
          className="sidebar-toggle-btn glass-panel"
          onClick={() => setIsOpen(true)}
        >
          <span>❯</span>
        </button>
      )}

      <div className={`sidebar glass-panel ${!isOpen ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <h2>🏙️ 3D Urban Twin</h2>
          <button className="close-btn" onClick={() => setIsOpen(false)}>✕</button>
        </div>

        <div className="connection-badge" style={{ borderColor: statusColor }}>
          <span className="pulse-dot" style={{ backgroundColor: statusColor }}></span>
          <span className="status-text">{wsStatus.toUpperCase()}</span>
        </div>

        <div className="sidebar-content">
          <LayerControls
            layerVisibility={layerVisibility}
            onLayerVisibilityChange={onLayerVisibilityChange}
          />

          <hr className="divider" />

          <div className="section-title">
            <h3>Live Fleet Tracking</h3>
            <span className="live-badge">LIVE</span>
          </div>
          <FleetPanel fleetData={fleetData} />
        </div>

        <div className="sidebar-footer">
          Powered by CesiumJS + OGC API Features
        </div>
      </div>
    </>
  )
}
