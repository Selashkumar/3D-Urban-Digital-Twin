import { useState, useEffect } from 'react'
import CesiumMap3D from './components/CesiumMap3D'
import Sidebar from './components/Sidebar'
import BuildingPopup from './components/BuildingPopup'
import StatsBar from './components/StatsBar'
import InitialLoader from './components/InitialLoader'
import { useLiveUpdates } from './hooks/useLiveUpdates'
import { useOGCData } from './hooks/useOGCData'
import { CITY_BBOX } from './utils/mapConfig'
import { apiUrl } from './utils/apiConfig'

function App() {
  const [selectedBuilding, setSelectedBuilding] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [layerVisibility, setLayerVisibility] = useState({
    buildings: true,
    fleet: true,
    imagery: 'esri',
  })
  const [backendStatus, setBackendStatus] = useState('checking')
  const [liveUpdatesEnabled, setLiveUpdatesEnabled] = useState(false)
  const [buildingInteractionEnabled, setBuildingInteractionEnabled] = useState(false)
  const [mapLoading, setMapLoading] = useState(true)

  const { status: wsStatus, lastFleetUpdate, lastBuildingUpdate } = useLiveUpdates(liveUpdatesEnabled)
  const { data: buildingsData, loading: buildingsLoading } = useOGCData('buildings', {
    bbox: CITY_BBOX,
    limit: 500,
  })
  const { data: fleetData } = useOGCData('fleet')

  const [buildings, setBuildings] = useState(null)

  useEffect(() => {
    if (buildingsData) setBuildings(buildingsData)
  }, [buildingsData])

  useEffect(() => {
    if (!lastBuildingUpdate?.features?.length) return
    setBuildings(prev => {
      if (!prev?.features) return prev
      const patches = new Map(
        lastBuildingUpdate.features.map(f => [f.properties?.featureId, f])
      )
      return {
        ...prev,
        features: prev.features.map(f =>
          patches.has(f.properties?.featureId) ? patches.get(f.properties.featureId) : f
        ),
      }
    })
  }, [lastBuildingUpdate])

  const liveFleetData = lastFleetUpdate?.features
    ? { type: 'FeatureCollection', features: lastFleetUpdate.features }
    : fleetData

  useEffect(() => {
    fetch(apiUrl('/health'))
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(() => setBackendStatus('ok'))
      .catch(() => setBackendStatus('unreachable'))
  }, [])

  const connectionStatus =
    wsStatus === 'connected' && backendStatus === 'ok'
      ? 'connected'
      : wsStatus === 'connecting' || backendStatus === 'checking'
        ? 'connecting'
        : 'disconnected'

  return (
    <div className="app-container">
      <InitialLoader visible={mapLoading} />
      <StatsBar
        buildings={buildings}
        fleet={liveFleetData}
        connectionStatus={connectionStatus}
        loading={buildingsLoading}
      />

      <div className="main-content">
        <Sidebar
          isOpen={sidebarOpen}
          setIsOpen={setSidebarOpen}
          wsStatus={wsStatus}
          layerVisibility={layerVisibility}
          onLayerVisibilityChange={setLayerVisibility}
          fleetData={liveFleetData}
          liveUpdatesEnabled={liveUpdatesEnabled}
          onLiveUpdatesToggle={setLiveUpdatesEnabled}
          buildingInteractionEnabled={buildingInteractionEnabled}
          onBuildingInteractionToggle={setBuildingInteractionEnabled}
        />

        <div className="map-wrapper">
          {/* ── 3D Cesium World Canvas ── */}
          <CesiumMap3D
            layerVisibility={layerVisibility}
            onBuildingClick={setSelectedBuilding}
            selectedBuilding={selectedBuilding}
            buildingInteractionEnabled={buildingInteractionEnabled}
            onMapReady={() => setMapLoading(false)}
          />

          {/* ── Building Detail Popup ── */}
          {buildingInteractionEnabled && selectedBuilding && (
            <BuildingPopup
              feature={selectedBuilding}
              onClose={() => setSelectedBuilding(null)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default App
