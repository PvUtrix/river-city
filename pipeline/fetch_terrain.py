"""Download elevation for the model extent and write the web heightmap.

Source: Mapzen Terrain Tiles on AWS Open Data (Terrarium encoding), which carry
SRTM at this latitude. Tiles are cached under pipeline/.cache/terrain.

Outputs:
  pipeline/.cache/dem.npy     float32 metres, full resolution (pipeline use)
  public/data/terrain.png     decimetres above sea level as 16 bits: red = high byte,
                              green = low byte (PNG, so any static host serves it)
  public/data/meta.json       grid size, bounds and scale
"""

from __future__ import annotations

import io
import math
import time
import urllib.request

import numpy as np
from PIL import Image

from common import CACHE, DEM_ZOOM, OUT, grid, metres_per_px, px_to_lonlat, read_json, write_json

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def fetch_tile(z: int, x: int, y: int) -> np.ndarray:
    path = CACHE / "terrain" / f"{z}-{x}-{y}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(4):
            try:
                req = urllib.request.Request(TILE_URL.format(z=z, x=x, y=y), headers={"User-Agent": "river-city/0.1"})
                path.write_bytes(urllib.request.urlopen(req, timeout=60).read())
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 + attempt * 3)
    rgb = np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB"), dtype=np.float32)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def main() -> None:
    g = grid()
    px0, py0, w, h = g["px0"], g["py0"], g["width"], g["height"]
    tx0, ty0 = px0 // 256, py0 // 256
    tx1, ty1 = (px0 + w - 1) // 256, (py0 + h - 1) // 256
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mosaic[(ty - ty0) * 256 : (ty - ty0 + 1) * 256, (tx - tx0) * 256 : (tx - tx0 + 1) * 256] = fetch_tile(DEM_ZOOM, tx, ty)
    ox, oy = px0 - tx0 * 256, py0 - ty0 * 256
    dem = mosaic[oy : oy + h, ox : ox + w]

    # Terrarium voids come through as large negatives; nothing here is below 300 m.
    bad = dem < 100
    if bad.any():
        dem[bad] = np.median(dem[~bad])
    (CACHE).mkdir(parents=True, exist_ok=True)
    np.save(CACHE / "dem.npy", dem)

    OUT.mkdir(parents=True, exist_ok=True)
    dm = np.round(dem * 10).astype(np.uint16)
    rgb = np.stack([dm >> 8, dm & 0xFF, np.zeros_like(dm)], axis=-1).astype(np.uint8)
    Image.fromarray(rgb).save(OUT / "terrain.png", optimize=True)

    west, north = px_to_lonlat(px0, py0)
    east, south = px_to_lonlat(px0 + w, py0 + h)
    # Merge, don't overwrite: build_layers.py adds "texture" and "zones" to the
    # same file, and re-running only this step must not drop them.
    meta_path = OUT / "meta.json"
    meta = read_json(meta_path) if meta_path.exists() else {}
    meta |= {
        "width": w,
        "height": h,
        "zoom": DEM_ZOOM,
        "originPx": [px0, py0],
        "metresPerPx": round(metres_per_px(), 4),
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "elevation": {"min": float(dem.min()), "max": float(dem.max()), "unit": "dm", "encoding": "png-rg16"},
    }
    write_json(meta_path, meta)
    km = lambda px: px * meta["metresPerPx"] / 1000
    print(f"DEM {w}x{h} px = {km(w):.1f} x {km(h):.1f} km, {dem.min():.0f}-{dem.max():.0f} m")


if __name__ == "__main__":
    main()
