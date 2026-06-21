#!/usr/bin/env python3
"""
seed_gpkg.py - Ingest real building data from OpenStreetMap, calculate realistic
geographic NDVI indices, and seed a 100% OGC compliant GeoPackage (.gpkg)
complete with R*Tree spatial indexes.
"""

import sqlite3
import json
import random
import math
import struct
import sys
import time
import argparse
from pathlib import Path
from datetime import datetime

# Config
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
OUTPUT_PATH = PROJECT_ROOT / "backend" / "data" / "urban_twin.gpkg"
CACHE_PATH = SCRIPT_DIR / ".overpass_cache.json"

# Study Area: Generic Metropolitan Area
# Bbox format for Overpass: south,west,north,east
DEFAULT_BBOX = "40.735,-73.995,40.760,-73.975"

# Bbox coordinates as numbers for other checks
LON_MIN, LON_MAX = -73.995, -73.975
LAT_MIN, LAT_MAX = 40.735, 40.760

SEED = 42
random.seed(SEED)

OVERPASS_ENDPOINTS = [
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

BUILDING_TYPE_MAP = {
    "apartments":   "residential",
    "house":        "residential",
    "residential":  "residential",
    "detached":     "residential",
    "office":       "commercial",
    "commercial":   "commercial",
    "retail":       "commercial",
    "supermarket":  "commercial",
    "hotel":        "mixed",
    "mixed_use":    "mixed",
    "industrial":   "industrial",
    "warehouse":    "industrial",
    "yes":          "residential",
}

# ─── OGC GeoPackage Binary Geometry Encoder ────────────────────────────────────
def to_gpkg_binary_geometry(geojson: dict) -> bytes:
    # 8-byte GPKG Header: Magic 'GP', ver 0, flags 1 (little endian, no envelope), SRS 4326
    header = struct.pack("<2sBB I", b"GP", 0, 1, 4326)
    
    g_type = geojson["type"]
    if g_type == "Point":
        # WKB Point: byteOrder (1) + type (1) + X (double) + Y (double)
        lon, lat = geojson["coordinates"]
        wkb = struct.pack("<BIdd", 1, 1, lon, lat)
    elif g_type == "Polygon":
        # WKB Polygon: byteOrder (1) + type (3) + numRings (uint)
        rings = geojson["coordinates"]
        parts = [struct.pack("<BII", 1, 3, len(rings))]
        for ring in rings:
            # Ring: numPoints (uint) + list of points
            parts.append(struct.pack("<I", len(ring)))
            for pt in ring:
                parts.append(struct.pack("<dd", pt[0], pt[1]))
        wkb = b"".join(parts)
    else:
        raise ValueError(f"Unsupported geometry type: {g_type}")
        
    return header + wkb

# ─── Bounding Box Helpers for R*Tree ───────────────────────────────────────────
def get_bbox_polygon(geojson: dict) -> tuple:
    coords = geojson["coordinates"][0]
    lons = [pt[0] for pt in coords]
    lats = [pt[1] for pt in coords]
    return min(lons), max(lons), min(lats), max(lats)

# ─── GeoPackage Metadata Initialization ─────────────────────────────────────────
def init_gpkg(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.executescript("""
        PRAGMA application_id = 1196444743;  -- GPKG
        PRAGMA user_version = 10300;          -- gpkg 1.3.0

        CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
            srs_name                 TEXT    NOT NULL,
            srs_id                   INTEGER NOT NULL PRIMARY KEY,
            organization             TEXT    NOT NULL,
            organization_coordsys_id INTEGER NOT NULL,
            definition               TEXT    NOT NULL,
            description              TEXT
        );

        CREATE TABLE IF NOT EXISTS gpkg_contents (
            table_name  TEXT     NOT NULL PRIMARY KEY,
            data_type   TEXT     NOT NULL,
            identifier  TEXT,
            description TEXT     DEFAULT '',
            last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            min_x       REAL,
            min_y       REAL,
            max_x       REAL,
            max_y       REAL,
            srs_id      INTEGER,
            FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
        );

        CREATE TABLE IF NOT EXISTS gpkg_geometry_columns (
            table_name      TEXT NOT NULL,
            column_name     TEXT NOT NULL,
            geometry_type_name TEXT NOT NULL,
            srs_id          INTEGER NOT NULL,
            z               TINYINT NOT NULL DEFAULT 0,
            m               TINYINT NOT NULL DEFAULT 0,
            CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
            FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
            FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
        );
    """)

    cur.execute("""
        INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES
            ('WGS 84', 4326, 'EPSG', 4326,
             'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
             'World Geodetic System 1984'),
            ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined'),
            ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined')
    """)
    conn.commit()

def register_layer(conn: sqlite3.Connection, table_name: str, geom_type: str,
                   identifier: str, description: str, bbox: tuple) -> None:
    cur = conn.cursor()
    min_x, min_y, max_x, max_y = bbox
    cur.execute("""
        INSERT OR REPLACE INTO gpkg_contents
            (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
        VALUES (?, 'features', ?, ?, ?, ?, ?, ?, 4326)
    """, (table_name, identifier, description, min_x, min_y, max_x, max_y))

    cur.execute("""
        INSERT OR REPLACE INTO gpkg_geometry_columns
            (table_name, column_name, geometry_type_name, srs_id, z, m)
        VALUES (?, 'geom', ?, 4326, 0, 0)
    """, (table_name, geom_type))
    conn.commit()

# ─── Overpass OSM Data Procurement ─────────────────────────────────────────────
def fetch_osm_buildings(bbox: str) -> list[dict]:
    query = f"""
    [out:json][timeout:60];
    (
      way["building"]({bbox});
      relation["building"]({bbox});
    );
    out body geom;
    """
    
    # Try cache first
    if CACHE_PATH.exists():
        print(f"  reading OSM buildings from cache: {CACHE_PATH}")
        try:
            with open(CACHE_PATH) as f:
                return json.load(f).get("elements", [])
        except Exception:
            pass

    import requests
    print("  fetching OSM footprints from Overpass API (this may take up to 30 seconds)...")
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            headers = {"User-Agent": "UrbanDigitalTwin/0.1"}
            resp = requests.post(endpoint, data={"data": query}, headers=headers, timeout=30)
            if resp.status_code == 200:
                elements = resp.json().get("elements", [])
                if elements:
                    # Cache successful result
                    with open(CACHE_PATH, "w") as f:
                        json.dump({"elements": elements}, f)
                    print(f"    cached {len(elements)} elements")
                    return elements
        except Exception as e:
            print(f"    endpoint {endpoint} failed: {e}")
            time.sleep(1)
            
    print("  WARNING: All Overpass mirrors failed. Falling back to cached data or local fallback.")
    return []

# ─── Geometry conversion ───────────────────────────────────────────────────────
def osm_way_to_polygon(element: dict) -> dict | None:
    geometry = element.get("geometry", [])
    if len(geometry) < 4:
        return None
    coords = [[node["lon"], node["lat"]] for node in geometry]
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    if len(coords) < 4:
        return None
    return {"type": "Polygon", "coordinates": [coords]}

def osm_relation_to_polygon(element: dict) -> dict | None:
    members = element.get("members", [])
    outer_ways = [m for m in members if m.get("role") == "outer" and m.get("type") == "way"]
    if not outer_ways:
        return None
    
    first_outer = outer_ways[0]
    geometry = first_outer.get("geometry", [])
    if len(geometry) < 4:
        return None
    
    coords = [[node["lon"], node["lat"]] for node in geometry]
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    if len(coords) < 4:
        return None
    return {"type": "Polygon", "coordinates": [coords]}

# ─── Attributes parsing ────────────────────────────────────────────────────────
def parse_height(tags: dict) -> float:
    if "height" in tags:
        h = tags["height"].replace("m", "").replace(" ", "").strip()
        if h.endswith("ft"):
            try:
                return round(float(h[:-2]) * 0.3048, 1)
            except ValueError:
                pass
        try:
            return round(float(h), 1)
        except ValueError:
            pass

    if "building:levels" in tags:
        try:
            levels = float(tags["building:levels"])
            return round(levels * 3.5, 1)
        except ValueError:
            pass

    # Random fallback for realistic variation
    return round(random.uniform(12, 45), 1)

def parse_year_built(tags: dict) -> int:
    for tag in ["start_date", "year_built", "construction:date"]:
        if tag in tags:
            val = tags[tag].strip()
            for i in range(len(val) - 3):
                chunk = val[i:i+4]
                if chunk.isdigit() and 1800 <= int(chunk) <= 2026:
                    return int(chunk)
    return random.randint(1910, 2020)

# ─── Realistic NDVI greenness scoring based on Midtown Parks ──────────────────
GREEN_SPOTS = [
    { "lon": -73.9835, "lat": 40.7536, "r": 0.002 },  # Bryant Park
    { "lon": -74.0044, "lat": 40.7480, "r": 0.003 },  # High Line
    { "lon": -73.9877, "lat": 40.7484, "r": 0.001 },  # Madison Square/Greeley
    { "lon": -73.9712, "lat": 40.7644, "r": 0.008 },  # Central Park (southern edge)
    { "lon": -74.0090, "lat": 40.7400, "r": 0.005 },  # Hudson River Park
]

def calculate_realistic_ndvi(lon: float, lat: float) -> tuple[float, str]:
    green_boost = 0.0
    for spot in GREEN_SPOTS:
        dist = math.sqrt((lon - spot["lon"]) ** 2 + (lat - spot["lat"]) ** 2)
        if dist < spot["r"]:
            green_boost = max(green_boost, (1 - dist / spot["r"]) * 0.65)

    base = -0.05 + random.uniform(0.0, 0.15)
    value = min(0.78, base + green_boost + random.gauss(0, 0.02))

    if value < 0:
        ndvi_class = "water"
    elif value < 0.15:
        ndvi_class = "impervious"
    elif value < 0.35:
        ndvi_class = "sparse"
    elif value < 0.55:
        ndvi_class = "moderate"
    else:
        ndvi_class = "dense"

    return round(value, 4), ndvi_class

# ─── Seeding local/OSM buildings ───────────────────────────────────────────────
def seed_buildings(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS buildings (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT,
            height      REAL NOT NULL,
            floors      INTEGER NOT NULL,
            status      TEXT NOT NULL DEFAULT 'operational',
            material    TEXT NOT NULL DEFAULT 'concrete',
            year_built  INTEGER,
            ndvi_score  REAL NOT NULL DEFAULT 0.05,
            use_type    TEXT NOT NULL DEFAULT 'commercial',
            geom        BLOB NOT NULL
        )
    """)
    cur.execute("CREATE VIRTUAL TABLE IF NOT EXISTS rtree_buildings_geom USING rtree(id, minx, maxx, miny, maxy)")

    elements = fetch_osm_buildings(DEFAULT_BBOX)
    buildings = []

    for el in elements:
        el_type = el.get("type")
        geom = None
        if el_type == "way":
            geom = osm_way_to_polygon(el)
        elif el_type == "relation":
            geom = osm_relation_to_polygon(el)
        
        if geom is None:
            continue

        tags = el.get("tags", {})
        b_type_raw = tags.get("building", "yes")
        b_type = BUILDING_TYPE_MAP.get(b_type_raw, "residential")
        
        height = parse_height(tags)
        try:
            floors = max(1, int(round(float(tags.get("building:levels", height / 3.5)))))
        except ValueError:
            floors = max(1, int(round(height / 3.5)))
        
        # calculate centroid for ndvi
        coords = geom["coordinates"][0]
        clon = sum(pt[0] for pt in coords) / len(coords)
        clat = sum(pt[1] for pt in coords) / len(coords)
        ndvi, _ = calculate_realistic_ndvi(clon, clat)

        buildings.append({
            "name": tags.get("name") or tags.get("addr:housename"),
            "height": height,
            "floors": floors,
            "status": "operational",
            "material": random.choice(["concrete", "glass", "brick", "steel"]),
            "year_built": parse_year_built(tags),
            "ndvi_score": ndvi,
            "use_type": b_type,
            "geom": to_gpkg_binary_geometry(geom),
            "geojson": geom
        })

    # If Overpass completely failed and there's no cache, fall back to mock data
    if not buildings:
        print("  OSM data unavailable. Generating high-quality mock buildings...")
        landmarks = [
            {"name": "Empire State Building", "lon": -73.9857, "lat": 40.7484, "height": 443, "use_type": "commercial"},
            {"name": "One Penn Plaza", "lon": -73.9913, "lat": 40.7502, "height": 228, "use_type": "commercial"},
            {"name": "30 Hudson Yards", "lon": -74.0017, "lat": 40.7536, "height": 387, "use_type": "commercial"},
            {"name": "Chrysler Building", "lon": -73.9754, "lat": 40.7516, "height": 319, "use_type": "commercial"},
        ]
        for lm in landmarks:
            # build a simple polygon
            hw, hd = 0.0004, 0.00025
            geom = {
                "type": "Polygon",
                "coordinates": [[
                    [lm["lon"] - hw, lm["lat"] - hd],
                    [lm["lon"] + hw, lm["lat"] - hd],
                    [lm["lon"] + hw, lm["lat"] + hd],
                    [lm["lon"] - hw, lm["lat"] + hd],
                    [lm["lon"] - hw, lm["lat"] - hd],
                ]]
            }
            buildings.append({
                "name": lm["name"], "height": lm["height"], "floors": int(lm["height"] / 3.5),
                "status": "operational", "material": "steel", "year_built": 1930,
                "ndvi_score": 0.05, "use_type": lm["use_type"],
                "geom": to_gpkg_binary_geometry(geom), "geojson": geom
            })

    # Cap to max 600 buildings to ensure high performance on local maps
    if len(buildings) > 600:
        # keep landmarks if named, otherwise sample
        buildings.sort(key=lambda x: (x["name"] is None, -x["height"]))
        buildings = buildings[:600]

    # Insert buildings + populate R*Tree index
    for b in buildings:
        cur.execute("""
            INSERT INTO buildings (name, height, floors, status, material, year_built, ndvi_score, use_type, geom)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (b["name"], b["height"], b["floors"], b["status"], b["material"], b["year_built"], b["ndvi_score"], b["use_type"], b["geom"]))
        
        # Get last inserted rowid
        rowid = cur.lastrowid
        minx, maxx, miny, maxy = get_bbox_polygon(b["geojson"])
        cur.execute("""
            INSERT INTO rtree_buildings_geom (id, minx, maxx, miny, maxy)
            VALUES (?, ?, ?, ?, ?)
        """, (rowid, minx, maxx, miny, maxy))

    conn.commit()
    print(f"  successfully indexed {len(buildings)} buildings in R*Tree")
    
    register_layer(
        conn, "buildings", "POLYGON",
        "Urban Twin Buildings", "Real building footprints from OpenStreetMap",
        bbox=(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX)
    )

# ─── Seeding fleet vehicles ───────────────────────────────────────────────────
def seed_fleet(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fleet (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id  TEXT NOT NULL UNIQUE,
            type        TEXT NOT NULL,
            lon         REAL NOT NULL,
            lat         REAL NOT NULL,
            speed       REAL,
            heading     REAL,
            status      TEXT NOT NULL DEFAULT 'moving',
            timestamp   TEXT,
            geom        BLOB NOT NULL
        )
    """)
    cur.execute("CREATE VIRTUAL TABLE IF NOT EXISTS rtree_fleet_geom USING rtree(id, minx, maxx, miny, maxy)")

    vehicle_types = ["delivery", "bus", "truck", "emergency"]
    type_weights  = [0.40, 0.25, 0.20, 0.15]
    statuses = ["moving", "idle", "stopped"]

    for i in range(20):
        lon = random.uniform(LON_MIN, LON_MAX)
        lat = random.uniform(LAT_MIN, LAT_MAX)
        vtype = random.choices(vehicle_types, weights=type_weights, k=1)[0]
        abbrev = { "delivery": "DEL", "bus": "BUS", "truck": "TRK", "emergency": "EMR" }[vtype]
        v_id = f"NYC-{abbrev}-{i+1:03d}"
        
        geom = {
            "type": "Point",
            "coordinates": [round(lon, 6), round(lat, 6)]
        }
        geom_bytes = to_gpkg_binary_geometry(geom)
        speed = round(random.uniform(10, 60), 1) if random.random() > 0.3 else 0.0
        heading = round(random.uniform(0, 360), 1)
        status = random.choice(statuses)
        ts = datetime.utcnow().isoformat() + "Z"

        cur.execute("""
            INSERT INTO fleet (vehicle_id, type, lon, lat, speed, heading, status, timestamp, geom)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (v_id, vtype, lon, lat, speed, heading, status, ts, geom_bytes))
        
        rowid = cur.lastrowid
        cur.execute("""
            INSERT INTO rtree_fleet_geom (id, minx, maxx, miny, maxy)
            VALUES (?, ?, ?, ?, ?)
        """, (rowid, lon, lon, lat, lat))

    conn.commit()
    print("  successfully indexed 20 fleet vehicles in R*Tree")
    
    register_layer(
        conn, "fleet", "POINT",
        "Fleet Vehicles", "Mock fleet vehicle GPS tracking positions",
        bbox=(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX)
    )

# ─── Seeding NDVI grid ─────────────────────────────────────────────────────────
def seed_ndvi_grid(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ndvi_grid (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ndvi_value  REAL NOT NULL,
            class       TEXT NOT NULL,
            cell_col    INTEGER,
            cell_row    INTEGER,
            geom        BLOB NOT NULL
        )
    """)
    cur.execute("CREATE VIRTUAL TABLE IF NOT EXISTS rtree_ndvi_grid_geom USING rtree(id, minx, maxx, miny, maxy)")

    grid_size = 0.0018
    col = 0
    cells_count = 0
    
    lon = LON_MIN
    while lon < LON_MAX:
        row = 0
        lat = LAT_MIN
        while lat < LAT_MAX:
            center_lon = lon + grid_size / 2
            center_lat = lat + grid_size / 2
            ndvi, ndvi_class = calculate_realistic_ndvi(center_lon, center_lat)

            geom = {
                "type": "Polygon",
                "coordinates": [[
                    [lon,             lat],
                    [lon + grid_size, lat],
                    [lon + grid_size, lat + grid_size],
                    [lon,             lat + grid_size],
                    [lon,             lat],
                ]]
            }
            geom_bytes = to_gpkg_binary_geometry(geom)

            cur.execute("""
                INSERT INTO ndvi_grid (ndvi_value, class, cell_col, cell_row, geom)
                VALUES (?, ?, ?, ?, ?)
            """, (ndvi, ndvi_class, col, row, geom_bytes))
            
            rowid = cur.lastrowid
            minx, maxx = lon, lon + grid_size
            miny, maxy = lat, lat + grid_size
            cur.execute("""
                INSERT INTO rtree_ndvi_grid_geom (id, minx, maxx, miny, maxy)
                VALUES (?, ?, ?, ?, ?)
            """, (rowid, minx, maxx, miny, maxy))
            
            cells_count += 1
            row += 1
            lat += grid_size
        col += 1
        lon += grid_size

    conn.commit()
    print(f"  successfully indexed {cells_count} NDVI grid cells in R*Tree")

    register_layer(
        conn, "ndvi_grid", "POLYGON",
        "NDVI Grid", "Geographically calculated vegetation grid cells for the study area",
        bbox=(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX)
    )

# ─── Main Seeding Execution ────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Create optimized and indexed OGC GeoPackage database.")
    parser.add_argument("--gpkg", default=str(OUTPUT_PATH), help="Destination .gpkg file path")
    args = parser.parse_args()

    gpkg_path = Path(args.gpkg)
    print(f"Seeding professional OGC compliant GeoPackage -> {gpkg_path}")

    # Ensure parent directory exists
    gpkg_path.parent.mkdir(parents=True, exist_ok=True)

    # Delete existing GPKG
    if gpkg_path.exists():
        try:
            gpkg_path.unlink()
        except OSError:
            pass

    conn = sqlite3.connect(str(gpkg_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    try:
        init_gpkg(conn)
        seed_buildings(conn)
        seed_fleet(conn)
        seed_ndvi_grid(conn)
        print("\n🏆 Seeding Completed Successfully with R*Tree indexing!")
    except Exception as e:
        print(f"\n❌ Error seeding database: {e}", file=sys.stderr)
        conn.close()
        if gpkg_path.exists():
            try:
                gpkg_path.unlink()
            except OSError:
                pass
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
