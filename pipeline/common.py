"""Shared configuration and projection helpers for the River City data pipeline.

Everything is laid out on one Web Mercator pixel grid at DEM_ZOOM. The DEM is a
crop of that grid; the cartographic textures are the same crop at TEX_SCALE
times the resolution. Over a ~25 km extent Mercator is conformal and its scale
varies by well under 1%, so a single metres-per-pixel at the centre latitude is
accurate enough for both the web model and a 3D print.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / ".cache"
OUT = ROOT / "public" / "data"

# Beloretsk, Republic of Bashkortostan, Southern Urals.
# The box holds the whole urban settlement (53.89-54.02 N, 58.31-58.57 E) plus
# the ridges around it: Malinovaya (1152 m) and Kirel (1162 m) to the north-west.
SOUTH, WEST, NORTH, EAST = 53.86, 58.18, 54.08, 58.62
CENTER_LAT = (SOUTH + NORTH) / 2

DEM_ZOOM = 12  # ~22.5 m/px here; the SRTM source is ~30 m, so more zoom adds nothing
TEX_SCALE = 3  # cartographic textures at ~7.5 m/px

EARTH_PX = 156543.03392804097  # metres per pixel at zoom 0 on the equator


def lonlat_to_px(lon: float, lat: float, zoom: int = DEM_ZOOM) -> tuple[float, float]:
    n = 256 * 2**zoom
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def px_to_lonlat(x: float, y: float, zoom: int = DEM_ZOOM) -> tuple[float, float]:
    n = 256 * 2**zoom
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def metres_per_px(zoom: int = DEM_ZOOM) -> float:
    return EARTH_PX * math.cos(math.radians(CENTER_LAT)) / 2**zoom


def grid() -> dict:
    """Integer pixel window of the DEM crop at DEM_ZOOM."""
    x0, y0 = lonlat_to_px(WEST, NORTH)
    x1, y1 = lonlat_to_px(EAST, SOUTH)
    px0, py0 = math.floor(x0), math.floor(y0)
    px1, py1 = math.ceil(x1), math.ceil(y1)
    return {"px0": px0, "py0": py0, "width": px1 - px0, "height": py1 - py0}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
