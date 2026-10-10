"""Download OpenStreetMap features for the model extent and normalise them.

Overpass mirrors are often busy, so every query retries across several. Raw
responses are cached under pipeline/.cache/osm; delete that folder to refresh.

Multipolygon relations are stitched into rings here rather than with GDAL, so
the pipeline needs nothing beyond numpy, Pillow and scipy.

Output: pipeline/.cache/features.json — a list of
  {"layer", "kind": "polygon"|"line"|"point", "tags", "rings"|"coords"|"lonlat"}
with polygon rings as {"role": "outer"|"inner", "coords": [[lon, lat], ...]}.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

from common import CACHE, EAST, NORTH, SOUTH, WEST, write_json

MIRRORS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

B = f"{SOUTH},{WEST},{NORTH},{EAST}"
QUERIES = {
    "water": f'(nwr["natural"="water"]({B});nwr["landuse"="reservoir"]({B});nwr["waterway"="riverbank"]({B});way["waterway"]({B}););out geom;',
    "land": (
        f'(nwr["landuse"]({B});'
        f'nwr["natural"~"^(wood|scrub|grassland|heath|wetland|bare_rock|scree|sand|shingle)$"]({B});'
        f'nwr["leisure"~"^(park|garden|nature_reserve|pitch|stadium|track)$"]({B}););out geom;'
    ),
    "buildings": f'(way["building"]({B});relation["building"]({B}););out geom;',
    "roads": f'(way["highway"]({B});way["railway"]({B}););out geom;',
    "points": (
        f'(node["natural"~"^(peak|spring|cave_entrance|rock|saddle)$"]({B});node["place"]({B});'
        f'node["historic"]({B});node["tourism"~"^(viewpoint|museum|attraction)$"]({B}););out;'
    ),
}

AREA_KEYS = {"building", "landuse", "leisure", "amenity", "water"}
LINEAR_NATURAL = {"coastline", "tree_row", "cliff", "ridge", "arete", "valley", "gorge"}


def overpass(name: str, query: str) -> dict:
    path = CACHE / "osm" / f"{name}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    body = urllib.parse.urlencode({"data": f"[out:json][timeout:180];{query}"}).encode()
    for attempt in range(8):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": "river-city/0.1"})
                raw = urllib.request.urlopen(req, timeout=240).read()
            except Exception as exc:  # network errors and 5xx alike: try the next mirror
                print(f"  {name}: {url.split('/')[2]} failed ({exc.__class__.__name__})")
                continue
            if raw[:1] == b"{":
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                print(f"  {name}: {len(raw) / 1e6:.1f} MB from {url.split('/')[2]}")
                return json.loads(raw)
            print(f"  {name}: {url.split('/')[2]} busy")
        time.sleep(10 + attempt * 5)
    raise SystemExit(f"Overpass failed for {name}")


def pt(p: dict) -> tuple[float, float]:
    return (round(p["lon"], 7), round(p["lat"], 7))


def stitch(segments: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Join open way segments end to end into rings."""
    segs = [s[:] for s in segments if len(s) >= 2]
    rings = []
    while segs:
        cur = segs.pop()
        joined = True
        while cur[0] != cur[-1] and joined:
            joined = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur = cur + s[1:]
                elif s[-1] == cur[-1]:
                    cur = cur + s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s + cur[1:]
                elif s[0] == cur[0]:
                    cur = s[::-1] + cur[1:]
                else:
                    continue
                segs.pop(i)
                joined = True
                break
        if len(cur) >= 4:
            rings.append(cur)
    return rings


def is_area_way(tags: dict, coords: list) -> bool:
    if len(coords) < 4 or coords[0] != coords[-1]:
        return False
    if tags.get("area") == "yes":
        return True
    if tags.get("natural") and tags["natural"] not in LINEAR_NATURAL:
        return True
    return bool(AREA_KEYS & tags.keys())


def normalise(layer: str, data: dict) -> list[dict]:
    out = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        if el["type"] == "node":
            if tags:
                out.append({"layer": layer, "kind": "point", "tags": tags, "lonlat": [el["lon"], el["lat"]]})
        elif el["type"] == "way" and "geometry" in el:
            coords = [pt(p) for p in el["geometry"] if p]
            if is_area_way(tags, coords):
                out.append({"layer": layer, "kind": "polygon", "tags": tags, "rings": [{"role": "outer", "coords": coords}]})
            elif len(coords) >= 2:
                out.append({"layer": layer, "kind": "line", "tags": tags, "coords": coords})
        elif el["type"] == "relation" and tags.get("type") in ("multipolygon", "boundary"):
            rings = []
            for role in ("outer", "inner"):
                segs = [
                    [pt(p) for p in m["geometry"] if p]
                    for m in el.get("members", [])
                    if m["type"] == "way" and m.get("geometry") and (m.get("role") or "outer") == role
                ]
                rings += [{"role": role, "coords": r} for r in stitch(segs)]
            if rings:
                out.append({"layer": layer, "kind": "polygon", "tags": tags, "rings": rings})
    return out


def main() -> None:
    features = []
    for name, query in QUERIES.items():
        feats = normalise(name, overpass(name, query))
        print(f"{name}: {len(feats)} features")
        features += feats
    write_json(CACHE / "features.json", features)


if __name__ == "__main__":
    main()
