import React from 'react'
import LayerControls from './LayerControls'
import FleetPanel from './FleetPanel'
import { CityIcon } from './Icons'

export default function Sidebar({
  isOpen,
  setIsOpen,
  wsStatus,
  layerVisibility,
  onLayerVisibilityChange,
  fleetData,
  liveUpdatesEnabled,
  onLiveUpdatesToggle,
  buildingInteractionEnabled,
  onBuildingInteractionToggle,
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
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CityIcon size={22} style={{ color: 'var(--accent-cyan)' }} />
            3D Urban Twin
          </h2>
          <button className="close-btn" onClick={() => setIsOpen(false)}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 4px', marginBottom: 16 }}>
          {/* Status & Live Sync Row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="connection-badge" style={{ borderColor: statusColor, margin: 0 }}>
              <span className="pulse-dot" style={{ backgroundColor: statusColor }}></span>
              <span className="status-text">{wsStatus.toUpperCase()}</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Live Sync</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={liveUpdatesEnabled}
                  onChange={(e) => onLiveUpdatesToggle(e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
            </div>
          </div>

          {/* Building Interaction Info Toggle Row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Building Info</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={buildingInteractionEnabled}
                  onChange={(e) => onBuildingInteractionToggle(e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
            </div>
          </div>
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
