// FleetPanel.jsx — live vehicle list
// originally rendered this inside Map3D as MapLibre popups but it cluttered the map too much
// moving it to the sidebar was the right call

import { useMemo } from 'react'
import { FLEET_TYPE_COLORS } from '../utils/mapConfig'
import { TruckIcon, BusIcon, EmergencyIcon, DeliveryIcon, CarIcon } from './Icons'

const VEHICLE_ICONS = {
  truck:     TruckIcon,
  bus:       BusIcon,
  emergency: EmergencyIcon,
  delivery:  DeliveryIcon,
}

const STATUS_LABELS = {
  moving:  { label: 'Moving',  color: 'var(--accent-green)' },
  idle:    { label: 'Idle',    color: 'var(--text-muted)' },
  stopped: { label: 'Stopped', color: 'var(--accent-orange)' },
}

export default function FleetPanel({ fleetData }) {
  const vehicles = useMemo(() => {
    if (!fleetData?.features) return []
    // sort: moving first, then by vehicle id
    return [...fleetData.features].sort((a, b) => {
      const aMoving = a.properties?.status === 'moving' ? 0 : 1
      const bMoving = b.properties?.status === 'moving' ? 0 : 1
      return aMoving - bMoving || (a.properties?.vehicle_id || '').localeCompare(b.properties?.vehicle_id || '')
    })
  }, [fleetData])

  const movingCount = vehicles.filter(v => v.properties?.status === 'moving').length

  if (vehicles.length === 0) {
    return (
      <div style={{ padding: '12px 0' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          color: 'var(--text-muted)',
          fontSize: 12,
          gap: 8,
          flexDirection: 'column',
        }}>
          <CarIcon size={24} style={{ color: 'var(--text-muted)' }} />
          <span>No fleet data</span>
          <span style={{ fontSize: 10 }}>Backend may be loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* header with live badge */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <p className="section-label" style={{ margin: 0 }}>Fleet Vehicles</p>
        <div className="live-badge">
          <div className="status-dot connected" style={{ width: 5, height: 5 }} />
          LIVE
        </div>
      </div>

      <div style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        marginBottom: 10,
      }}>
        <span className="mono" style={{ color: 'var(--accent-green)' }}>{movingCount}</span>
        <span> moving · </span>
        <span className="mono" style={{ color: 'var(--text-secondary)' }}>{vehicles.length}</span>
        <span> total</span>
      </div>

      {/* vehicle list */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        maxHeight: 240,
        overflowY: 'auto',
        paddingRight: 2,
      }}>
        {vehicles.map(vehicle => (
          <VehicleRow key={vehicle.properties?.vehicle_id || Math.random()} vehicle={vehicle} />
        ))}
      </div>
    </div>
  )
}

function VehicleRow({ vehicle }) {
  const props = vehicle.properties || {}
  const isMoving = props.status === 'moving'
  const color = FLEET_TYPE_COLORS[props.type] || FLEET_TYPE_COLORS.default
  const IconComp = VEHICLE_ICONS[props.type] || CarIcon
  const statusInfo = STATUS_LABELS[props.status] || { label: props.status, color: 'var(--text-muted)' }

  // coords from the GeoJSON geometry
  const [lon, lat] = vehicle.geometry?.coordinates || [0, 0]

  return (
    <div
      className={isMoving ? 'vehicle-moving' : ''}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 6,
        background: isMoving ? 'rgba(34, 197, 94, 0.05)' : 'var(--bg-glass)',
        border: `1px solid ${isMoving ? 'rgba(34, 197, 94, 0.15)' : 'var(--border-glass)'}`,
        transition: 'background 0.3s ease',
      }}
    >
      {/* type icon */}
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <IconComp size={16} style={{ color }} />
      </span>

      {/* id + position */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {props.vehicle_id || 'UNK'}
        </div>
        <div style={{
          fontSize: 9,
          color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {lat.toFixed(4)}, {lon.toFixed(4)}
        </div>
      </div>

      {/* speed */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div className="mono" style={{ fontSize: 12, color }}>
          {props.speed != null ? `${Math.round(props.speed)}` : '—'}
          <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 2 }}>km/h</span>
        </div>
        <div style={{
          fontSize: 9,
          color: statusInfo.color,
          fontWeight: 500,
          textAlign: 'right',
        }}>
          {statusInfo.label}
        </div>
      </div>

      {/* moving indicator dot */}
      <div style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: statusInfo.color,
        flexShrink: 0,
      }} />
    </div>
  )
}
