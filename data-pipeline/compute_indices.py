#!/usr/bin/env python3
"""
compute_indices.py - Compute NDVI and NDBI spectral indices from Sentinel-2 data.

Usage:
    # Mock mode (no API keys needed, generates synthetic values):
    python data-pipeline/compute_indices.py --mock

    # Real mode (requires Copernicus credentials in .env):
    python data-pipeline/compute_indices.py --date 2024-06-01

What this actually does in real life:
    1. Query the Copernicus Data Space (formerly Copernicus Open Access Hub) for a
       Sentinel-2 L2A granule covering our AOI (area of interest).
    2. Download the specific band files we need:
           B04 (Red, 10m resolution) -> for NDVI
           B08 (NIR, 10m resolution) -> for NDVI + NDBI
           B11 (SWIR 1, 20m resolution) -> for NDBI
    3. Resample B11 to 10m to match the others (GDAL warp).
    4. Compute per-pixel indices.
    5. Write results back to the GeoPackage (reprojecting from UTM to WGS84).

Why Sentinel-2 and not Landsat?
    - Sentinel-2 has 10m spatial resolution for the bands we care about (Landsat = 30m)
    - Free, open access under the Copernicus programme
    - 5-day revisit time over the study area
    - L2A products are atmospherically corrected, so we don't have to deal with
      dark object subtraction ourselves

Copernicus Data Space API docs:
    https://documentation.dataspace.copernicus.eu/APIs/OData.html

STAC alternative (honestly might be cleaner):
    https://catalogue.dataspace.copernicus.eu/stac
"""

import json
import random
import math
import argparse
import os
import sys
from pathlib import Path
from datetime import datetime, date
from typing import Optional

# we'd normally import these for real processing, but keeping them optional
# so the mock mode works without a full geospatial install
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    print("Warning: numpy not found, mock mode will use math.sqrt instead")

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # fine, just won't have .env support

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
OUTPUT_JSON = PROJECT_ROOT / "indices_output.json"
GPKG_PATH = PROJECT_ROOT / "urban_twin.gpkg"

# our study area AOI
AOI_BBOX = {
    "lon_min": -73.995,
    "lat_min": 40.735,
    "lon_max": -73.975,
    "lat_max": 40.760,
}

# Sentinel-2 band IDs on Copernicus Data Space
# format is the suffix used in the JP2 filenames within the .SAFE archive
SENTINEL2_BANDS = {
    "B04": "Red (665nm)      - 10m resolution",
    "B08": "NIR (842nm)      - 10m resolution",
    "B11": "SWIR-1 (1610nm)  - 20m resolution",
}

# NDVI interpretation thresholds (rough guidelines, varies by season/region)
NDVI_CLASSES = {
    (-1.0, 0.0):  "non-vegetation (water, bare soil, urban)",
    ( 0.0, 0.1):  "sparse/stressed vegetation or bare soil",
    ( 0.1, 0.3):  "low vegetation (grass, shrubs)",
    ( 0.3, 0.5):  "moderate vegetation density",
    ( 0.5, 1.0):  "dense healthy vegetation",
}


# ---------------------------------------------------------------------------
# Real data path (sketched out, not fully implemented)
# ---------------------------------------------------------------------------

def get_sentinel2_token() -> Optional[str]:
    """
    Get an OAuth2 token from the Copernicus Identity Service.

    You need to register at https://dataspace.copernicus.eu/ to get credentials.
    Store them in .env as:
        COPERNICUS_USER=your@email.com
        COPERNICUS_PASS=yourpassword

    The token expires after 10 minutes, so in a real pipeline you'd want to
    handle refresh. For a one-shot script this is fine.
    """
    import requests  # only import if we're in real mode

    user = os.getenv("COPERNICUS_USER")
    password = os.getenv("COPERNICUS_PASS")

    if not user or not password:
        raise ValueError(
            "COPERNICUS_USER and COPERNICUS_PASS must be set in .env\n"
            "Register at https://dataspace.copernicus.eu/"
        )

    resp = requests.post(
        "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
        data={
            "client_id": "cdse-public",
            "grant_type": "password",
            "username": user,
            "password": password,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def search_sentinel2_granules(token: str, target_date: str, max_cloud_cover: float = 20.0) -> list:
    """
    Search for Sentinel-2 L2A granules over our AOI using the OData API.

    We want L2A (not L1C) because:
    - L1C = top-of-atmosphere reflectance (raw sensor data + geometry correction)
    - L2A = bottom-of-atmosphere (surface) reflectance after atmospheric correction
    - For NDVI/NDBI you want L2A -- otherwise clouds and haze mess up your values

    Args:
        token: Copernicus OAuth2 token
        target_date: ISO date string like "2024-06-01"
        max_cloud_cover: skip scenes with more than this % cloud cover

    Returns:
        list of product metadata dicts from the OData API
    """
    import requests

    # OData filter: L2A product, covers our bounding box, low clouds, near target date
    # the INTERSECTS filter uses WKT geometry -- our bbox as a polygon
    bbox_wkt = (
        f"POLYGON(({AOI_BBOX['lon_min']} {AOI_BBOX['lat_min']},"
        f"{AOI_BBOX['lon_max']} {AOI_BBOX['lat_min']},"
        f"{AOI_BBOX['lon_max']} {AOI_BBOX['lat_max']},"
        f"{AOI_BBOX['lon_min']} {AOI_BBOX['lat_max']},"
        f"{AOI_BBOX['lon_min']} {AOI_BBOX['lat_min']}))"
    )

    # OData query -- the $filter syntax is a bit verbose but it works
    filter_expr = (
        f"Collection/Name eq 'SENTINEL-2' and "
        f"Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType' "
        f"  and att/OData.CSC.StringAttribute/Value eq 'S2MSI2A') and "
        f"ContentDate/Start ge {target_date}T00:00:00.000Z and "
        f"ContentDate/Start le {target_date}T23:59:59.999Z and "
        f"OData.CSC.Intersects(area=geography'SRID=4326;{bbox_wkt}')"
    )

    resp = requests.get(
        "https://catalogue.dataspace.copernicus.eu/odata/v1/Products",
        params={"$filter": filter_expr, "$top": 5, "$orderby": "ContentDate/Start desc"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    resp.raise_for_status()

    products = resp.json().get("value", [])
    # filter by cloud cover -- the attribute is buried in a list
    # TODO: there's probably a cleaner way to do this in the OData filter itself
    filtered = []
    for p in products:
        attrs = {a["Name"]: a.get("Value") for a in p.get("Attributes", [])}
        cloud_pct = float(attrs.get("cloudCover", 100))
        if cloud_pct <= max_cloud_cover:
            filtered.append(p)

    return filtered


def download_band(product_id: str, band: str, token: str, output_dir: Path) -> Path:
    """
    Download a single Sentinel-2 band JP2 file from Copernicus Data Space.

    In practice the download involves:
    1. Getting the product's node tree (list of files within the .SAFE archive)
    2. Finding the file matching our band (e.g., "*_B04_10m.jp2")
    3. Streaming the download (files can be 100-200MB each)

    This is where GDAL /vsis3 or /vsicurl would shine for cloud-native processing --
    you could read just the pixels you need without downloading the whole file.
    But that's a rabbit hole for later.

    TODO: implement actual download + JP2 -> GeoTIFF conversion
    """
    raise NotImplementedError(
        "Real download not yet implemented.\n"
        "Run with --mock for synthetic data.\n"
        f"Product ID would be: {product_id}, Band: {band}"
    )


def compute_index_from_arrays(band_a, band_b):
    """
    Compute a normalized difference index: (A - B) / (A + B)

    This is the core formula for NDVI, NDBI, MNDWI, etc. -- they're all just
    normalized differences between two bands. The key is picking the right bands.

    Args:
        band_a, band_b: numpy arrays of float32 reflectance values [0, 1]
                        (L2A data is scaled -- raw values are in [0, 10000] for
                         uint16 storage, divide by 10000 to get reflectance)

    Returns:
        numpy array of index values in [-1, 1]
        pixels where both bands are zero get NaN (division by zero guard)
    """
    if not HAS_NUMPY:
        raise RuntimeError("numpy required for real index computation")

    denom = band_a + band_b
    # avoid division by zero -- masked arrays would be cleaner but this works
    with np.errstate(invalid="ignore"):
        result = np.where(denom != 0, (band_a - band_b) / denom, np.nan)

    return result.astype(np.float32)


# ---------------------------------------------------------------------------
# Mock mode - generates plausible synthetic index values
# ---------------------------------------------------------------------------

LAND_COVER_NDVI = {
    # (mean, std) pairs -- we'll sample from these distributions
    "high_density_urban": (0.05,  0.08),
    "low_density_urban":  (0.15,  0.10),
    "park":               (0.55,  0.12),
    "water":              (0.00,  0.05),
    "road":               (0.02,  0.04),
}

LAND_COVER_NDBI = {
    "high_density_urban": (0.30,  0.08),
    "low_density_urban":  (0.15,  0.10),
    "park":               (-0.20, 0.08),
    "water":              (-0.35, 0.08),
    "road":               (0.20,  0.06),
}


def generate_mock_indices(grid_size_deg: float = 0.002) -> list[dict]:
    """
    Generate a grid of mock NDVI/NDBI values.

    The NDVI formula is (NIR - Red) / (NIR + Red) -- we're mocking this with
    random values seeded by land cover type. The distributions are calibrated
    to typical Sentinel-2 values you'd see over a dense urban area.

    Grid size of 0.002° ≈ 220m at the study area's latitude. That's coarser than
    the 10m native Sentinel-2 resolution, but fine for visualization.

    In real life you'd probably aggregate 10m pixels to whatever grid size makes
    sense for your visualization -- the raw 10m raster would be 2000x2500 pixels
    for our AOI, which is totally fine for GDAL but overkill for a MapLibre overlay.
    """
    random.seed(42)  # reproducible

    lon_range = AOI_BBOX["lon_max"] - AOI_BBOX["lon_min"]
    lat_range = AOI_BBOX["lat_max"] - AOI_BBOX["lat_min"]
    n_lon = int(lon_range / grid_size_deg)
    n_lat = int(lat_range / grid_size_deg)

    print(f"  generating {n_lon}x{n_lat} grid = {n_lon * n_lat} cells")

    cells = []
    for i in range(n_lon):
        for j in range(n_lat):
            lon = AOI_BBOX["lon_min"] + i * grid_size_deg
            lat = AOI_BBOX["lat_min"] + j * grid_size_deg

            # assign land cover based on rough heuristic
            # (same logic as seed_gpkg.py -- ideally we'd share a config module)
            roll = random.random()
            if roll < 0.05:
                lc = "park"
            elif roll < 0.10:
                lc = "water"
            elif roll < 0.20:
                lc = "road"
            elif roll < 0.35:
                lc = "low_density_urban"
            else:
                lc = "high_density_urban"

            ndvi_mean, ndvi_std = LAND_COVER_NDVI[lc]
            ndbi_mean, ndbi_std = LAND_COVER_NDBI[lc]

            ndvi = max(-1, min(1, random.gauss(ndvi_mean, ndvi_std)))
            ndbi = max(-1, min(1, random.gauss(ndbi_mean, ndbi_std)))

            cells.append({
                "cell_id": f"IDX-{i:03d}-{j:03d}",
                "lon": round(lon, 6),
                "lat": round(lat, 6),
                "lon_max": round(lon + grid_size_deg, 6),
                "lat_max": round(lat + grid_size_deg, 6),
                "ndvi": round(ndvi, 4),
                "ndbi": round(ndbi, 4),
                "land_cover": lc,
                "computed_at": datetime.utcnow().isoformat() + "Z",
                "source": "mock",
            })

    return cells


def classify_ndvi(ndvi: float) -> str:
    """Map an NDVI value to a human-readable class label."""
    for (lo, hi), label in NDVI_CLASSES.items():
        if lo <= ndvi < hi:
            return label
    return "unknown"


def run_mock(output_path: Path) -> None:
    print("Running in MOCK mode -- generating synthetic index values")
    print("(use --date YYYY-MM-DD for real Sentinel-2 data, requires .env credentials)")
    print()

    cells = generate_mock_indices()

    # add NDVI classification to each cell
    for cell in cells:
        cell["ndvi_class"] = classify_ndvi(cell["ndvi"])

    output = {
        "metadata": {
            "source": "mock",
            "aoi_bbox": AOI_BBOX,
            "grid_size_deg": 0.002,
            "n_cells": len(cells),
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "formulas": {
                "ndvi": "(B08 - B04) / (B08 + B04)  [NIR=B08, Red=B04]",
                "ndbi": "(B11 - B08) / (B11 + B08)  [SWIR-1=B11, NIR=B08]",
            },
        },
        "cells": cells,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"  wrote {len(cells)} cells to {output_path}")
    print(f"  file size: {output_path.stat().st_size / 1024:.1f} KB")

    # print a quick summary
    ndvi_vals = [c["ndvi"] for c in cells]
    ndbi_vals = [c["ndbi"] for c in cells]
    avg = lambda vals: sum(vals) / len(vals)
    print(f"\nSummary:")
    print(f"  NDVI: min={min(ndvi_vals):.3f}, max={max(ndvi_vals):.3f}, mean={avg(ndvi_vals):.3f}")
    print(f"  NDBI: min={min(ndbi_vals):.3f}, max={max(ndbi_vals):.3f}, mean={avg(ndbi_vals):.3f}")
    print(f"  (Low mean NDVI makes sense -- we're looking at a dense urban area, not a large forest park)")


def run_real(target_date: str) -> None:
    """
    Real Sentinel-2 pipeline. Not fully implemented yet.

    TODO:
    - implement download_band()
    - implement JP2 reading (GDAL or rasterio)
    - implement reprojection from UTM 18N to WGS84
    - implement writing index rasters back to GeoPackage as raster tiles
    """
    print(f"Real mode: fetching Sentinel-2 data for {target_date}")

    try:
        token = get_sentinel2_token()
        print("  authenticated with Copernicus Data Space")
    except Exception as e:
        print(f"  Auth failed: {e}", file=sys.stderr)
        sys.exit(1)

    granules = search_sentinel2_granules(token, target_date)
    if not granules:
        print(f"  No suitable granules found for {target_date} (try a nearby date or raise cloud cover threshold)")
        sys.exit(1)

    granule = granules[0]  # take the best match
    print(f"  Found granule: {granule['Name']}")

    # TODO: download B04, B08, B11 and compute indices
    print("  Real download not yet implemented -- run with --mock")
    sys.exit(1)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Compute NDVI/NDBI from Sentinel-2 or generate mock values",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate mock index values (no credentials needed):
  python data-pipeline/compute_indices.py --mock

  # Fetch real Sentinel-2 data for a specific date (needs .env credentials):
  python data-pipeline/compute_indices.py --date 2024-06-15

  # Custom output path:
  python data-pipeline/compute_indices.py --mock --output /tmp/test_indices.json
        """,
    )
    parser.add_argument("--mock", action="store_true", help="Generate synthetic data instead of fetching from Copernicus")
    parser.add_argument("--date", type=str, help="ISO date for Sentinel-2 search (YYYY-MM-DD)")
    parser.add_argument("--output", type=str, default=str(OUTPUT_JSON), help="Output JSON path")

    args = parser.parse_args()

    if not args.mock and not args.date:
        parser.print_help()
        print("\nError: must specify either --mock or --date", file=sys.stderr)
        sys.exit(1)

    output_path = Path(args.output)

    if args.mock:
        run_mock(output_path)
    else:
        run_real(args.date)


if __name__ == "__main__":
    main()
