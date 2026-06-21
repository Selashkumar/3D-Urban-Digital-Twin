# 3D Urban Digital Twin

A full-stack 3D city visualization pipeline built with MapLibre GL JS, a Node.js OGC API backend, and a GeoPackage data store.

## What this is

This project serves as a dynamic 3D "digital twin" of the metropolitan study area. It demonstrates how to stream spatial data (buildings, vehicles, NDVI heatmaps) from an SQLite-based GeoPackage container through an OGC-compliant REST API to a web-based 3D canvas with live WebSocket updates.

**Note:** The repository includes a mock data generator (`backend/db/seed.js`) for quick local demos. Python scripts in `data-pipeline/` support optional real OSM/Sentinel-2 ingestion (see below).

## Architecture

- **Data Layer:** GeoPackage (SQLite) storing spatial data (WKB + GeoJSON text)
- **Backend:** Node.js + Express serving OGC API – Features endpoints + WebSockets for real-time fleet/building updates
- **Frontend:** React + Vite + MapLibre GL JS with 3D building extrusions and NDVI overlay
- **Workers:** In-process fleet simulator (3s) and building construction updater (45s)
- **Pipeline:** Python scripts for optional OSM fetch and raster index computation

## Quick Start

### Prerequisites

- Node.js 18+

### Running locally

1. **Seed the database**

   ```bash
   cd backend
   npm install
   npm run seed
   ```

2. **Start the backend**

   ```bash
   npm run dev
   ```

3. **Start the frontend** (new terminal)

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

Open `http://localhost:5173`. The frontend proxies `/api`, `/health`, and `/ws` to the backend on port 3001.

## The Stack

| Component | Tech | Role |
|---|---|---|
| Frontend | React + Vite | Dashboard UI, MapLibre 3D canvas |
| 3D Map | MapLibre GL JS | Terrain, fill-extrusion buildings, NDVI |
| Backend | Node.js + Express | OGC API – Features + WebSocket |
| DB | better-sqlite3 | GeoPackage read/write |
| Streaming | WebSocket (`ws`) | Live fleet + building updates |

## OGC API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/` | Landing page |
| `GET /api/conformance` | Conformance declaration |
| `GET /api/collections` | List collections |
| `GET /api/collections/{name}/items` | GeoJSON features (`bbox`, `limit`, `offset`) |
| `GET /api/collections/{name}/items/{id}` | Single feature |
| `GET /health` | Health check |

Collections: `buildings`, `fleet`, `ndvi_grid`

### WebSocket messages

Connect to `/ws`. Message types:

- `fleet_update` — `{ type, features: Feature[] }`
- `building_update` — `{ type, features: Feature[] }` (construction height/status changes)

## Data

The Node seed script generates:

- **416** building footprints with height, use type, and status
- **20** fleet vehicles (delivery, bus, truck, emergency)
- **168** NDVI grid cells

To reseed: `cd backend && npm run seed`

### Python data pipeline (optional)

Scripts in `data-pipeline/` can fetch real OSM building footprints and compute NDVI/NDBI indices. **Note:** The Python seed script (`seed_gpkg.py`) uses a different schema than the Node backend — use `backend/db/seed.js` as the canonical seed for this app.

## Azure Deployment

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Target | Secrets |
|---|---|---|
| `deploy-backend.yml` | Azure App Service | `AZURE_WEBAPP_NAME`, `AZURE_WEBAPP_PUBLISH_PROFILE` |
| `deploy-frontend.yml` | Azure Static Web Apps | `AZURE_STATIC_WEB_APPS_API_TOKEN`, `VITE_API_BASE_URL`, `VITE_WS_BASE_URL` |

### Backend (App Service)

1. Create an App Service (Node 20, Linux).
2. Upload or seed `urban_twin.gpkg` to persistent storage at `backend/data/`.
3. Set startup command: `npm start` with working directory `backend/`.
4. On first deploy, run `npm run seed` via SSH or Kudu console if no GPKG exists.

### Frontend (Static Web Apps)

1. Create an Azure Static Web App linked to this repo.
2. Set build output to `frontend/dist`.
3. Configure application settings:
   - `VITE_API_BASE_URL` = `https://your-app.azurewebsites.net`
   - `VITE_WS_BASE_URL` = `wss://your-app.azurewebsites.net`

WebSockets must connect directly to App Service (SWA does not proxy WebSocket).

## License

MIT
