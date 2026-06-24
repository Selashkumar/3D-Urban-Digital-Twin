import { USE_TYPE_COLORS, FLEET_TYPE_COLORS } from '../utils/mapConfig'
import { CityIcon, TruckIcon, BusIcon, EmergencyIcon, DeliveryIcon, CarIcon, SatelliteIcon } from './Icons'

const USE_TYPES = [
  { key: 'commercial',  label: 'Commercial',  color: USE_TYPE_COLORS.commercial },
  { key: 'residential', label: 'Residential', color: USE_TYPE_COLORS.residential },
  { key: 'mixed',       label: 'Mixed Use',   color: USE_TYPE_COLORS.mixed },
  { key: 'industrial',  label: 'Industrial',  color: USE_TYPE_COLORS.industrial },
]

const FLEET_TYPES = [
  { key: 'truck',     label: 'Freight',   icon: TruckIcon, color: FLEET_TYPE_COLORS.truck },
  { key: 'bus',       label: 'Transit',   icon: BusIcon, color: FLEET_TYPE_COLORS.bus },
  { key: 'emergency', label: 'Emergency', icon: EmergencyIcon, color: FLEET_TYPE_COLORS.emergency },
  { key: 'delivery',  label: 'Delivery',  icon: DeliveryIcon, color: FLEET_TYPE_COLORS.delivery },
]

export default function LayerControls({
  layerVisibility,
  onLayerVisibilityChange,
}) {
  function handleToggle(layerKey) {
    onLayerVisibilityChange({
      ...layerVisibility,
      [layerKey]: !layerVisibility[layerKey],
    })
  }

  return (
    <div>
      <p className="section-label">Layer Control</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <LayerToggleRow
          label="3D Building Structures"
          active={layerVisibility.structures}
          accent="var(--accent-blue)"
          icon={<CityIcon size={16} style={{ color: 'var(--accent-blue)' }} />}
          onToggle={() => handleToggle('structures')}
        />
        <LayerToggleRow
          label="Building Info & Labels"
          active={layerVisibility.buildings}
          accent="var(--accent-cyan)"
          icon={<CityIcon size={16} style={{ color: 'var(--accent-cyan)' }} />}
          onToggle={() => handleToggle('buildings')}
        />
        <LayerToggleRow
          label="Fleet Vehicles"
          active={layerVisibility.fleet}
          accent="var(--accent-green)"
          icon={<CarIcon size={16} style={{ color: 'var(--accent-green)' }} />}
          onToggle={() => handleToggle('fleet')}
        />
        <LayerToggleRow
          label="Sentinel-2 Imagery"
          active={layerVisibility.imagery === 'sentinel'}
          accent="var(--accent-purple)"
          icon={<SatelliteIcon size={16} style={{ color: 'var(--accent-purple)' }} />}
          onToggle={() => {
            onLayerVisibilityChange({
              ...layerVisibility,
              imagery: layerVisibility.imagery === 'sentinel' ? 'esri' : 'sentinel',
            })
          }}
        />
      </div>

      <div className="divider" style={{ marginTop: 16 }} />

      {layerVisibility.buildings && (
        <div style={{ marginBottom: 12 }}>
          <p className="section-label">Building Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {USE_TYPES.map(ut => (
              <div key={ut.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: ut.color,
                  flexShrink: 0,
                  boxShadow: `0 0 6px ${ut.color}80`,
                }} />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{ut.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {layerVisibility.fleet && (
        <div style={{ marginBottom: 12 }}>
          <p className="section-label">Fleet Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {FLEET_TYPES.map(ft => {
              const IconComp = ft.icon
              return (
                <div key={ft.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: ft.color,
                    flexShrink: 0,
                    boxShadow: `0 0 6px ${ft.color}80`,
                  }} />
                  <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-secondary)' }}>
                    <IconComp size={14} style={{ color: ft.color }} />
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{ft.label}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function LayerToggleRow({ label, active, accent, icon, onToggle, disabled, disabledNote }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 8px',
      borderRadius: 'var(--radius-sm)',
      background: active ? `${accent}10` : 'transparent',
      border: `1px solid ${active ? `${accent}30` : 'transparent'}`,
      transition: 'all 0.2s ease',
      opacity: disabled ? 0.45 : 1,
    }}>
      <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>
      <span style={{
        flex: 1,
        fontSize: 12,
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontWeight: active ? 500 : 400,
      }}>
        {label}
        {disabled && disabledNote && (
          <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>
            ({disabledNote})
          </span>
        )}
      </span>

      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={active}
          onChange={onToggle}
          disabled={disabled}
        />
        <span
          className="toggle-track"
          style={active ? { background: `${accent}25`, borderColor: accent } : {}}
        />
      </label>
    </div>
  )
}
