#!/usr/bin/env python3
"""
overpass_fetch.py - Fetch real building data from OpenStreetMap via Overpass API

This is how you'd get real building data for the metropolitan area instead of using the mock
seed script. Run this if you want actual OSM buildings in the viewer.

Warning: OSM buildings in the study area = ~50k features. The Overpass response will be
several MB of JSON, parsing takes a few seconds, and writing to GeoPackage takes
a while. Budget about 2-3 minutes for the full run.

The Overpass API is public and rate-limited -- don't hammer it. One request per
30 seconds is the polite limit. Use --cache to avoid re-downloading on reruns.

Usage:
    # Fetch for our default midtown AOI:
    python data-pipeline/overpass_fetch.py

    # Fetch a custom bounding box (south,west,north,east):
    python data-pipeline/overpass_fetch.py --bbox 40.70,-74.02,40.78,-73.93

    # Use cached response (skip the API call):
    python data-pipeline/overpass_fetch.py --cache

Overpass API docs: https://wiki.openstreetmap.org/wiki/Overpass_API
Overpass Turbo (interactive query builder): https://overpass-turbo.eu/
"""

import json
import sqlite3
import time
import sys
import argparse
from pathlib import Path
from datetime import datetime

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
GPKG_PATH = PROJECT_ROOT / "urban_twin.gpkg"
CACHE_PATH = SCRIPT_DIR / ".overpass_cache.json"

# Default AOI: study area island
# bbox format for Overpass: south,west,north,east
DEFAULT_BBOX = "40.70,-74.02,40.78,-73.93"

# Overpass API endpoints -- use one of these (they're mirrors of the same data)
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",    # lz4 compressed responses, faster
    "https://overpass.kumi.systems/api/interpreter",   # community mirror
]

# The query we want to run
# [out:json] = JSON output (alternative is XML, but JSON is easier to parse)
# [timeout:60] = give up after 60 seconds server-side (might need to raise this for big areas)
# out body geom = include full geometry in the response (otherwise you just get node IDs)
OVERPASS_QUERY_TEMPLATE = """
[out:json][timeout:60];
(
  way["building"]({bbox});
  relation["building"]({bbox});
);
out body geom;
"""

# These OSM building=* values map to roughly what building category
BUILDING_TYPE_MAP = {
    "apartments":   "residential",
    "house":        "residential",
    "residential":  "residential",
    "detached":     "residential",
    "semidetached_house": "residential",
    "office":       "office",
    "commercial":   "office",
    "retail":       "retail",
    "supermarket":  "retail",
    "hotel":        "mixed",
    "mixed_use":    "mixed",
    "yes":          "unknown",       # "yes" just means "there's a building here" -- thanks OSM
    "industrial":   "industrial",
    "warehouse":    "industrial",
    "church":       "civic",
    "public":       "civic",
    "school":       "civic",
    "university":   "civic",
    "hospital":     "civic",
    "train_station": "transit",
    "transportation": "transit",
}


# ---------------------------------------------------------------------------
# HTTP setup with retries
# ---------------------------------------------------------------------------

def make_session() -> requests.Session:
    """
    Set up a requests session with automatic retries.

    Overpass API sometimes returns 429 (rate limited) or 503 (overloaded).
    The retry logic here handles both with exponential backoff.
    Don't set retry count too high -- if you're getting 429s, you need to
    slow down, not just retry faster.
    """
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=2,           # wait 2s, 4s, 8s between retries
        status_forcelist=[429, 500, 502, 503, 504],
        # don't retry POST by default, but Overpass uses POST for queries
        allowed_methods=["GET", "POST"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update({
        # Identify ourselves -- Overpass asks that you include contact info
        # in the User-Agent so they can reach you if your script is causing issues
        "User-Agent": "UrbanDigitalTwin/0.1 (dev-project; contact: see github repo)",
    })
    return session


# ---------------------------------------------------------------------------
# Overpass query + response parsing
# ---------------------------------------------------------------------------

def fetch_from_overpass(bbox: str, endpoint: str, session: requests.Session) -> dict:
    """
    Run an Overpass query and return the parsed JSON response.

    Overpass accepts queries via POST (preferred for long queries) or GET.
    The [out:json] directive tells it to return JSON.

    Note: the response for all buildings is typically 15-30MB of JSON.
    requests.json() will parse the whole thing into memory. If memory is a concern,
    you could stream-parse with ijson, but for this use case it's fine.
    """
    query = OVERPASS_QUERY_TEMPLATE.format(bbox=bbox)

    print(f"  querying Overpass: {endpoint}")
    print(f"  bbox: {bbox}")
    print(f"  (this might take 30-60 seconds for large areas...)")

    start = time.time()
    resp = session.post(
        endpoint,
        data={"data": query},
        timeout=120,   # 120s total timeout -- Overpass can be slow under load
    )
    elapsed = time.time() - start

    if resp.status_code == 429:
        # rate limited -- tell the user how long to wait
        retry_after = int(resp.headers.get("Retry-After", 60))
        print(f"  Rate limited. Retry after {retry_after}s", file=sys.stderr)
        sys.exit(1)

    resp.raise_for_status()

    print(f"  got response in {elapsed:.1f}s ({len(resp.content) / 1024:.0f} KB)")

    return resp.json()


def try_endpoints(bbox: str, session: requests.Session) -> dict:
    """Try each Overpass endpoint in order until one works."""
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            return fetch_from_overpass(bbox, endpoint, session)
        except requests.RequestException as e:
            print(f"  {endpoint} failed: {e}, trying next...")
            last_err = e
            time.sleep(2)

    raise RuntimeError(f"All Overpass endpoints failed. Last error: {last_err}")


# ---------------------------------------------------------------------------
# Geometry conversion: OSM -> GeoJSON
# ---------------------------------------------------------------------------

def osm_way_to_geojson_polygon(element: dict) -> dict | None:
    """
    Convert an OSM 'way' element with geometry to a GeoJSON Polygon.

    When you request 'out body geom', each way element includes a 'geometry'
    array of {lat, lon} objects. We need to convert this to GeoJSON coordinate
    format [lon, lat] (note the order swap -- OSM is lat/lon, GeoJSON is lon/lat).

    Returns None if the way doesn't have enough nodes to form a polygon (< 4,
    since GeoJSON polygons need at least 3 unique points + the closing point).
    """
    geometry = element.get("geometry", [])
    if len(geometry) < 4:
        return None

    # OSM way nodes might not be closed -- check and close if needed
    coords = [[node["lon"], node["lat"]] for node in geometry]
    if coords[0] != coords[-1]:
        coords.append(coords[0])

    if len(coords) < 4:
        return None

    return {"type": "Polygon", "coordinates": [coords]}


def osm_relation_to_geojson_multipolygon(element: dict) -> dict | None:
    """
    Convert an OSM 'relation' element to a GeoJSON MultiPolygon.

    Building relations in OSM typically have:
    - outer members: the outer boundary of the building
    - inner members: holes (courtyards, light wells, etc.)

    This handles the simple case of a single outer ring. The full multipolygon
    assembly algorithm (dealing with multiple outers, inner rings, etc.) is
    complex enough that in production you'd use osmium or osmnx rather than
    rolling your own.

    For now we just take the first outer member and make a simple polygon.
    TODO: proper multipolygon assembly for complex building relations
    """
    members = element.get("members", [])
    outer_ways = [m for m in members if m.get("role") == "outer" and m.get("type") == "way"]

    if not outer_ways:
        return None

    # just take the first outer way -- good enough for most buildings
    first_outer = outer_ways[0]
    geometry = first_outer.get("geometry", [])
    if len(geometry) < 4:
        return None

    coords = [[node["lon"], node["lat"]] for node in geometry]
    if coords[0] != coords[-1]:
        coords.append(coords[0])

    if len(coords) < 4:
        return None

    # return as a Polygon rather than MultiPolygon for simplicity
    # (the backend expects the same geometry type for all features in a table)
    return {"type": "Polygon", "coordinates": [coords]}


def parse_height(tags: dict) -> float | None:
    """
    Parse building height from OSM tags.

    OSM has several height-related tags with no strict standard:
    - height: "45", "45.5", "45 m", "148 ft" (yes, some are in feet)
    - building:levels: "12" (floors -- multiply by ~3.5m for rough height)
    - roof:height: additional height from the roof shape

    We try 'height' first, then fall back to levels * 3.5m.
    """
    # try 'height' tag first
    if "height" in tags:
        h = tags["height"].replace("m", "").replace(" ", "").strip()
        if h.endswith("ft"):
            try:
                return float(h[:-2]) * 0.3048  # feet to meters
            except ValueError:
                pass
        try:
            return float(h)
        except ValueError:
            pass

    # fall back to levels
    if "building:levels" in tags:
        try:
            levels = float(tags["building:levels"])
            return levels * 3.5  # rough average floor height
        except ValueError:
            pass

    return None


def parse_year_built(tags: dict) -> int | None:
    """
    Parse year of construction from OSM tags.

    start_date is used in OSM for the date a feature was created/constructed.
    Format varies: "1930", "1930-01-01", "ca. 1930", "~1930"
    We just grab the first 4 digits if they look like a year.
    """
    for tag in ["start_date", "year_built", "construction:date"]:
        if tag in tags:
            val = tags[tag].strip()
            # grab first 4-digit sequence that looks like a year
            for i in range(len(val) - 3):
                chunk = val[i:i+4]
                if chunk.isdigit() and 1800 <= int(chunk) <= 2030:
                    return int(chunk)
    return None


def osm_element_to_row(element: dict, geom: dict) -> dict:
    """Convert an OSM element + its GeoJSON geometry to a buildings table row."""
    tags = element.get("tags", {})
    building_tag = tags.get("building", "yes")

    return {
        "name": tags.get("name") or tags.get("addr:housename"),
        "height_m": parse_height(tags),
        "floors": int(tags["building:levels"]) if tags.get("building:levels", "").isdigit() else None,
        "type": BUILDING_TYPE_MAP.get(building_tag, "unknown"),
        "year_built": parse_year_built(tags),
        "osm_id": element.get("id"),
        "geom": json.dumps(geom),
    }


# ---------------------------------------------------------------------------
# GeoPackage writing
# ---------------------------------------------------------------------------

def ensure_osm_buildings_table(conn: sqlite3.Connection) -> None:
    """
    Create an osm_buildings table (separate from the mock buildings table).

    We keep them separate so you can have both mock and real data side by side
    and compare / toggle between them in the frontend. The schema adds an osm_id
    column that the mock data doesn't have.
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS osm_buildings (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT,
            height_m    REAL,
            floors      INTEGER,
            type        TEXT DEFAULT 'unknown',
            year_built  INTEGER,
            osm_id      INTEGER,
            geom        TEXT NOT NULL
        )
    """)

    # register in GeoPackage metadata tables if they exist
    # (they won't exist if the main GeoPackage hasn't been seeded yet)
    try:
        conn.execute("""
            INSERT OR REPLACE INTO gpkg_contents
                (table_name, data_type, identifier, description, srs_id)
            VALUES ('osm_buildings', 'features', 'OSM Buildings',
                    'Real building footprints from OpenStreetMap', 4326)
        """)
        conn.execute("""
            INSERT OR REPLACE INTO gpkg_geometry_columns
                (table_name, column_name, geometry_type_name, srs_id, z, m)
            VALUES ('osm_buildings', 'geom', 'POLYGON', 4326, 0, 0)
        """)
    except sqlite3.OperationalError:
        # gpkg metadata tables don't exist yet -- that's fine
        pass

    conn.commit()


def write_buildings_to_gpkg(buildings: list[dict], gpkg_path: Path) -> None:
    """Write parsed building rows to the GeoPackage."""

    conn = sqlite3.connect(str(gpkg_path))
    conn.execute("PRAGMA journal_mode=WAL")

    ensure_osm_buildings_table(conn)

    # clear existing OSM buildings so we can re-run idempotently
    conn.execute("DELETE FROM osm_buildings")

    # batch insert in chunks of 1000 to avoid SQLite parameter limits
    CHUNK = 1000
    total = 0
    for i in range(0, len(buildings), CHUNK):
        chunk = buildings[i:i + CHUNK]
        conn.executemany("""
            INSERT INTO osm_buildings (name, height_m, floors, type, year_built, osm_id, geom)
            VALUES (:name, :height_m, :floors, :type, :year_built, :osm_id, :geom)
        """, chunk)
        total += len(chunk)
        print(f"  wrote {total}/{len(buildings)} buildings...", end="\r")

    conn.commit()
    conn.close()
    print()  # newline after the \r progress line


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Fetch real OSM building data via Overpass API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fetch midtown study area buildings (default):
  python data-pipeline/overpass_fetch.py

  # Fetch all of the study area:
  python data-pipeline/overpass_fetch.py --bbox 40.70,-74.02,40.78,-73.93

  # Use cached response (saves time on reruns):
  python data-pipeline/overpass_fetch.py --cache

  # Print stats but don't write to GeoPackage:
  python data-pipeline/overpass_fetch.py --dry-run
        """,
    )
    parser.add_argument("--bbox", default=DEFAULT_BBOX,
                        help="Bounding box as south,west,north,east (default: %(default)s)")
    parser.add_argument("--cache", action="store_true",
                        help="Use cached Overpass response if available")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse response but don't write to GeoPackage")
    parser.add_argument("--gpkg", default=str(GPKG_PATH),
                        help="GeoPackage output path (default: %(default)s)")
    args = parser.parse_args()

    gpkg_path = Path(args.gpkg)

    print(f"OSM Building Fetcher")
    print(f"  bbox: {args.bbox}")
    print(f"  output: {gpkg_path}")
    print()

    # --- Fetch or load from cache ---
    if args.cache and CACHE_PATH.exists():
        print(f"Loading from cache: {CACHE_PATH}")
        with open(CACHE_PATH) as f:
            data = json.load(f)
    else:
        session = make_session()
        data = try_endpoints(args.bbox, session)

        # cache the response so reruns don't hit the API again
        print(f"  caching response to {CACHE_PATH}")
        with open(CACHE_PATH, "w") as f:
            json.dump(data, f)

    elements = data.get("elements", [])
    print(f"  {len(elements)} raw elements from Overpass")

    # --- Parse elements into building rows ---
    buildings = []
    skipped_no_geom = 0
    skipped_bad_geom = 0

    for el in elements:
        el_type = el.get("type")

        if el_type == "way":
            geom = osm_way_to_geojson_polygon(el)
        elif el_type == "relation":
            geom = osm_relation_to_geojson_multipolygon(el)
        else:
            skipped_no_geom += 1
            continue

        if geom is None:
            skipped_bad_geom += 1
            continue

        row = osm_element_to_row(el, geom)
        buildings.append(row)

    print(f"  parsed {len(buildings)} valid building polygons")
    print(f"  skipped: {skipped_no_geom} (no geometry) + {skipped_bad_geom} (bad geometry)")

    # stats
    named = sum(1 for b in buildings if b["name"])
    with_height = sum(1 for b in buildings if b["height_m"] is not None)
    print(f"  with name:   {named} ({named/len(buildings)*100:.0f}%)")
    print(f"  with height: {with_height} ({with_height/len(buildings)*100:.0f}%)")

    if args.dry_run:
        print("\n--dry-run: not writing to GeoPackage")
        return

    # --- Write to GeoPackage ---
    print(f"\nWriting to {gpkg_path}...")
    write_buildings_to_gpkg(buildings, gpkg_path)

    file_size_mb = gpkg_path.stat().st_size / (1024 * 1024)
    print(f"Done! {gpkg_path} ({file_size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
