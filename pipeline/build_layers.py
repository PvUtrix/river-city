"""Turn terrain + OSM features into the layers the site and the print use.

Two maps of the same ground, pixel-aligned with the heightmap at TEX_SCALE:

  today.webp   a cartographic picture of Beloretsk as mapped in OSM today
  zones.png    the River City plan, one zone id per pixel (see ZONES)

and, at DEM resolution, water_dem.png for engraving rivers into the print.

The plan is derived, not drawn by hand. The one modelled quantity is the
floodplain: height above the nearest main channel (HAND) from the DEM, so
"room for the river" follows the real valley floor of the Belaya and the Nura.
Everything else is a rule applied to what OSM says is there today.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from common import CACHE, OUT, TEX_SCALE, grid, lonlat_to_px, metres_per_px, read_json, write_json

# Zone ids are a contract with the site (it reads them back from zones.png and
# meta.json) — append new zones, never renumber.
ZONES = {
    0: "terrain",
    1: "forest",
    2: "meadow",
    3: "riverRoom",
    4: "greenFinger",
    5: "neighbourhood",
    6: "adaptiveEdge",
    7: "making",
    8: "remediation",
    9: "water",
    10: "building",
    11: "spine",
    12: "trail",
    13: "street",
    14: "promenade",
}
Z = {v: k for k, v in ZONES.items()}

PLAN_COLOURS = {
    "terrain": "#cfc8ad",
    "forest": "#2f6b45",
    "meadow": "#c9d08a",
    "riverRoom": "#3fb6a8",
    "greenFinger": "#82cc6c",
    "neighbourhood": "#f2c48d",
    "adaptiveEdge": "#f2c48d",  # striped with riverRoom, see stripes()
    "making": "#cf6f55",
    "remediation": "#9b7fc4",
    "water": "#2f8fd0",
    "building": "#fff4e2",
    "spine": "#ffffff",
    "trail": "#eadba9",
    "street": "#f8eedf",
    "promenade": "#ffd45e",
}

# OSM spells these names in Russian; they live in a data file, not in code.
OSM_NAMES = read_json(Path(__file__).with_name("osm_names_ru.json"))
MAIN_RIVERS = set(OSM_NAMES["mainRivers"])
FLOOD_HAND_M = 3.5  # height above the main channel still counted as floodplain
FLOOD_REACH_M = 1200  # and no farther than this from it
FINGER_HALF_WIDTH_M = 45
GREEN_WALK_M = 300

# Where each main river is labelled: on the Belaya downstream of the town, on the Nura upstream.
RIVER_LABEL_AT = {name: tuple(at) for name, at in OSM_NAMES["riverLabelAt"].items()}

# Urban settlement of Beloretsk (OSM admin_level 8 bounds), used to scope the promenade.
CITY_BOX = (58.3079, 53.8903, 58.5651, 54.0175)


def hex_rgb(h: str) -> tuple[int, int, int]:
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))


TODAY_COLOURS = {
    "meadow": "#c4cd96",
    "farm": "#d6d29b",
    "scrub": "#9fb07a",
    "forest": "#5e8656",
    "rock": "#a9a397",
    "wetland": "#93b9a6",
    "residential": "#ddd4c7",
    "commercial": "#dccabf",
    "industrial": "#bdb3aa",
    "waste": "#aaa198",
    "cemetery": "#a9b69c",
    "park": "#9cc483",
    "water": "#6ba7c9",
    "building": "#8d8075",
    "road_major": "#fffaf1",
    "road_minor": "#f5efe4",
    "track": "#b6a68a",
    "rail": "#6f6a66",
}


class Canvas:
    def __init__(self, scale: int):
        g = grid()
        self.scale = scale
        self.ox, self.oy = g["px0"], g["py0"]
        self.w, self.h = g["width"] * scale, g["height"] * scale
        self.mpp = metres_per_px() / scale

    def xy(self, coords) -> list[tuple[float, float]]:
        out = []
        for lon, lat in coords:
            x, y = lonlat_to_px(lon, lat)
            out.append(((x - self.ox) * self.scale, (y - self.oy) * self.scale))
        return out

    def blank(self) -> tuple[Image.Image, ImageDraw.ImageDraw]:
        im = Image.new("1", (self.w, self.h), 0)
        return im, ImageDraw.Draw(im)

    def polygons(self, feats) -> np.ndarray:
        im, d = self.blank()
        for f in feats:
            outers = [r for r in f["rings"] if r["role"] == "outer"]
            inners = [r for r in f["rings"] if r["role"] == "inner"]
            for r in outers:
                d.polygon(self.xy(r["coords"]), fill=1)
            for r in inners:
                d.polygon(self.xy(r["coords"]), fill=0)
        return np.asarray(im, dtype=bool)

    def lines(self, feats, width_px: float) -> np.ndarray:
        im, d = self.blank()
        w = max(1, round(width_px))
        for f in feats:
            pts = self.xy(f["coords"]) if "coords" in f else None
            if pts is None:
                for r in f["rings"]:
                    d.line(self.xy(r["coords"]), fill=1, width=w, joint="curve")
            else:
                d.line(pts, fill=1, width=w, joint="curve")
        return np.asarray(im, dtype=bool)


def tag_is(f, key, *values) -> bool:
    v = f["tags"].get(key)
    return v is not None and (not values or v in values)


def select(features):
    P = [f for f in features if f["kind"] == "polygon"]
    L = [f for f in features if f["kind"] == "line"]
    s = {}
    s["meadow"] = [f for f in P if tag_is(f, "natural", "grassland") or tag_is(f, "landuse", "meadow", "grass", "recreation_ground")]
    s["farm"] = [f for f in P if tag_is(f, "landuse", "farmland", "allotments", "farmyard", "plant_nursery")]
    s["scrub"] = [f for f in P if tag_is(f, "natural", "scrub", "heath")]
    s["forest"] = [f for f in P if tag_is(f, "natural", "wood") or tag_is(f, "landuse", "forest")]
    s["rock"] = [f for f in P if tag_is(f, "natural", "bare_rock", "scree", "sand", "shingle")]
    s["wetland"] = [f for f in P if tag_is(f, "natural", "wetland")]
    s["residential"] = [f for f in P if tag_is(f, "landuse", "residential", "religious", "construction")]
    s["commercial"] = [f for f in P if tag_is(f, "landuse", "commercial", "retail")]
    s["industrial"] = [f for f in P if tag_is(f, "landuse", "industrial", "garages", "railway")]
    s["cemetery"] = [f for f in P if tag_is(f, "landuse", "cemetery")]
    s["park"] = [f for f in P if tag_is(f, "leisure", "park", "garden", "pitch", "stadium", "track", "nature_reserve")]
    s["water_poly"] = [
        f for f in P
        if (tag_is(f, "natural", "water") or tag_is(f, "landuse", "reservoir") or tag_is(f, "waterway", "riverbank"))
    ]
    # Tailings, sludge ponds, landfills and quarries: the land the plan sets out to heal.
    s["waste"] = [
        f for f in P
        if tag_is(f, "landuse", "landfill", "quarry")
        or tag_is(f, "water", "wastewater")
        or f["tags"].get("name") == OSM_NAMES["sludgePond"]
    ]
    s["water_poly"] = [f for f in s["water_poly"] if f not in s["waste"]]
    s["rivers"] = [f for f in L if tag_is(f, "waterway", "river")]
    s["streams"] = [f for f in L if tag_is(f, "waterway", "stream", "canal", "ditch", "drain")]
    s["main_river_lines"] = [f for f in s["rivers"] if f["tags"].get("name") in MAIN_RIVERS]
    s["main_river_polys"] = [
        f for f in s["water_poly"]
        if f["tags"].get("water") in ("river", "oxbow", "pond", "reservoir") or f["tags"].get("name") in MAIN_RIVERS
    ]
    hw = lambda *v: [f for f in L if tag_is(f, "highway", *v)]
    s["road_major"] = hw("motorway", "trunk", "primary", "secondary", "tertiary", "primary_link", "secondary_link", "tertiary_link")
    s["road_minor"] = hw("residential", "unclassified", "living_street", "pedestrian", "road")
    s["service"] = hw("service")
    s["track"] = hw("track", "path", "footway", "bridleway", "cycleway", "steps")
    s["rail"] = [f for f in L if tag_is(f, "railway", "rail", "narrow_gauge", "tram")]
    s["buildings"] = [f for f in P if "building" in f["tags"]]
    return s


def floodplain(dem: np.ndarray, sel) -> tuple[np.ndarray, np.ndarray]:
    """Height above the nearest main channel (m) and distance to it (m), at DEM resolution."""
    c = Canvas(1)
    drain = c.lines(sel["main_river_lines"], 2) | c.polygons(sel["main_river_polys"])
    # Channel pixels pick up bank and tree height from SRTM; take the local low.
    channel = ndimage.minimum_filter(dem, size=3)
    dist, (iy, ix) = ndimage.distance_transform_edt(~drain, return_indices=True)
    hand = dem - channel[iy, ix]
    return hand.astype(np.float32), (dist * c.mpp).astype(np.float32)


def upsample(a: np.ndarray, w: int, h: int) -> np.ndarray:
    return np.asarray(Image.fromarray(a.astype(np.float32), mode="F").resize((w, h), Image.BILINEAR))


def main() -> None:
    dem = np.load(CACHE / "dem.npy")
    features = read_json(CACHE / "features.json")
    sel = select(features)
    c = Canvas(TEX_SCALE)
    m = lambda metres: metres / c.mpp  # metres -> texture px
    print(f"texture {c.w}x{c.h} px at {c.mpp:.2f} m/px")

    masks = {k: c.polygons(sel[k]) for k in (
        "meadow", "farm", "scrub", "forest", "rock", "wetland", "residential", "commercial",
        "industrial", "waste", "cemetery", "park", "water_poly", "buildings",
    )}
    masks["rivers"] = c.lines(sel["rivers"], m(30))
    masks["streams"] = c.lines(sel["streams"], m(12))
    masks["road_major"] = c.lines(sel["road_major"], m(22))
    masks["road_minor"] = c.lines(sel["road_minor"], m(12))
    masks["service"] = c.lines(sel["service"], m(8))
    masks["track"] = c.lines(sel["track"], m(6))
    masks["rail"] = c.lines(sel["rail"], m(10))

    # ---- today ------------------------------------------------------------
    elev = upsample(dem, c.w, c.h)
    t = np.clip((elev - 450) / 650, 0, 1)[..., None]
    low, high = np.array(hex_rgb("#cdd09f"), np.float32), np.array(hex_rgb("#b3ab98"), np.float32)
    today = low * (1 - t) + high * t
    paint = lambda mask, colour: today.__setitem__(mask, hex_rgb(TODAY_COLOURS[colour]))
    for key in ("meadow", "farm", "scrub", "forest", "rock", "wetland", "residential", "commercial",
                "industrial", "waste", "cemetery", "park"):
        paint(masks[key], key)
    paint(masks["water_poly"] | masks["rivers"] | masks["streams"], "water")
    paint(masks["track"], "track")
    paint(masks["service"] | masks["road_minor"], "road_minor")
    paint(masks["road_major"], "road_major")
    paint(masks["rail"], "rail")
    paint(masks["buildings"], "building")
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(today.astype(np.uint8)).save(OUT / "today.webp", lossless=True, method=6)

    # ---- River City plan ----------------------------------------------------
    hand, dist = floodplain(dem, sel)
    flood = (upsample(hand, c.w, c.h) <= FLOOD_HAND_M) & (upsample(dist, c.w, c.h) <= FLOOD_REACH_M)
    flood = ndimage.binary_opening(flood, iterations=2)

    zones = np.zeros((c.h, c.w), np.uint8)
    zones[masks["meadow"] | masks["farm"] | masks["scrub"]] = Z["meadow"]
    zones[masks["forest"]] = Z["forest"]
    zones[masks["rock"]] = Z["terrain"]
    zones[masks["wetland"]] = Z["riverRoom"]
    built = masks["residential"] | masks["commercial"] | masks["buildings"]
    zones[masks["residential"] | masks["commercial"]] = Z["neighbourhood"]
    zones[masks["industrial"]] = Z["making"]
    zones[masks["park"] | masks["cemetery"]] = Z["greenFinger"]

    # Green fingers: every stream gets a living corridor where it crosses open or built land.
    fingers = c.lines(sel["streams"], m(FINGER_HALF_WIDTH_M * 2)) | c.lines(sel["rivers"], m(FINGER_HALF_WIDTH_M * 3))
    open_or_built = np.isin(zones, [Z["terrain"], Z["meadow"], Z["neighbourhood"], Z["making"]])
    new_corridor = fingers & open_or_built
    zones[new_corridor] = Z["greenFinger"]

    # Room for the river: unbuilt floodplain goes back to the river; built floodplain adapts.
    built_any = built | masks["industrial"]
    zones[flood & ~built_any] = Z["riverRoom"]
    zones[flood & built_any] = Z["adaptiveEdge"]
    zones[masks["waste"]] = Z["remediation"]

    water = masks["water_poly"] | masks["rivers"]
    zones[water | masks["streams"]] = Z["water"]

    # Promenade along the pond and the rivers where they pass through the city.
    x0, y0 = c.xy([(CITY_BOX[0], CITY_BOX[3])])[0]
    x1, y1 = c.xy([(CITY_BOX[2], CITY_BOX[1])])[0]
    in_city = np.zeros_like(water)
    in_city[int(y0) : int(y1), int(x0) : int(x1)] = True
    shore = ndimage.binary_dilation(water, iterations=max(3, round(m(30)))) & ~water & in_city
    shore &= ~ndimage.binary_dilation(masks["buildings"], iterations=1)
    zones[shore & np.isin(zones, [Z["riverRoom"], Z["greenFinger"], Z["adaptiveEdge"], Z["neighbourhood"], Z["making"]])] = Z["promenade"]

    urban = np.isin(zones, [Z["neighbourhood"], Z["making"], Z["adaptiveEdge"]])
    zones[masks["track"] & ~urban & (zones != Z["water"])] = Z["trail"]
    zones[(masks["road_minor"] | masks["service"]) & (zones != Z["water"])] = Z["street"]
    zones[(masks["road_major"] | masks["rail"]) & (zones != Z["water"])] = Z["spine"]
    zones[masks["buildings"]] = Z["building"]
    Image.fromarray(zones, mode="L").save(OUT / "zones.png", optimize=True)
    Image.fromarray(plan_rgb(zones)).save(OUT / "plan.webp", lossless=True, method=6)

    # ---- print mask at DEM resolution ----------------------------------------
    d = Canvas(1)
    water_dem = d.polygons(sel["water_poly"]) | d.lines(sel["rivers"], 1.6)
    Image.fromarray((water_dem * 255).astype(np.uint8), mode="L").save(OUT / "water_dem.png", optimize=True)

    write_metrics(c, zones, masks, sel, features, new_corridor)
    write_labels(c, dem, features, sel)
    meta = read_json(OUT / "meta.json")
    meta["texture"] = {"width": c.w, "height": c.h, "scale": TEX_SCALE, "metresPerPx": round(c.mpp, 4)}
    meta["zones"] = {zid: {"key": key, "colour": PLAN_COLOURS[key]} for zid, key in ZONES.items()}
    write_json(OUT / "meta.json", meta)


def plan_rgb(zones: np.ndarray) -> np.ndarray:
    rgb = np.zeros(zones.shape + (3,), np.uint8)
    for zid, key in ZONES.items():
        rgb[zones == zid] = hex_rgb(PLAN_COLOURS[key])
    # Built land inside the floodplain: diagonal stripes of home and river, ~60 m apart.
    yy, xx = np.indices(zones.shape)
    stripe = ((xx + yy) // 4) % 2 == 0
    rgb[(zones == Z["adaptiveEdge"]) & stripe] = hex_rgb(PLAN_COLOURS["riverRoom"])
    return rgb


def write_metrics(c: Canvas, zones, masks, sel, features, new_corridor) -> None:
    ha = lambda mask: float(mask.sum()) * c.mpp**2 / 1e4
    area = {name: round(ha(zones == zid), 1) for zid, name in ZONES.items()}

    # Homes within a short walk of green or blue space, today vs the plan.
    green_today = masks["forest"] | masks["park"] | masks["water_poly"] | masks["rivers"] | masks["wetland"]
    green_plan = np.isin(zones, [Z["forest"], Z["riverRoom"], Z["greenFinger"], Z["water"], Z["promenade"]])
    walk_px = GREEN_WALK_M / c.mpp
    near_today = ndimage.distance_transform_edt(~green_today) <= walk_px
    near_plan = ndimage.distance_transform_edt(~green_plan) <= walk_px
    homes = [f for f in sel["buildings"] if f["tags"].get("building") in ("house", "detached", "apartments", "residential", "yes", "semidetached_house", "terrace", "dormitory")]
    res = masks["residential"]
    pts = []
    for f in homes:
        xy = c.xy(f["rings"][0]["coords"])
        x = int(sum(p[0] for p in xy) / len(xy))
        y = int(sum(p[1] for p in xy) / len(xy))
        if 0 <= x < c.w and 0 <= y < c.h and res[y, x]:
            pts.append((y, x))
    ys, xs = np.array(pts).T
    share = lambda near: round(100 * float(near[ys, xs].mean()), 1)

    # Length of waterway that gains a new corridor (forest streams already have one).
    stream_km = 0.0
    for f in sel["streams"] + [r for r in sel["rivers"] if r["tags"].get("name") not in MAIN_RIVERS]:
        xy = c.xy(f["coords"])
        for (ax, ay), (bx, by) in zip(xy, xy[1:]):
            mx, my = int((ax + bx) / 2), int((ay + by) / 2)
            if 0 <= mx < c.w and 0 <= my < c.h and new_corridor[my, mx]:
                stream_km += math.hypot(bx - ax, by - ay) * c.mpp / 1000

    pop = next((f["tags"].get("population") for f in features if f["kind"] == "point" and f["tags"].get("place") == "city"), None)
    metrics = {
        "areaHa": area,
        "homesCounted": len(pts),
        "homesNearGreenPct": {"today": share(near_today), "plan": share(near_plan), "walkMetres": GREEN_WALK_M},
        "greenFingerKm": round(stream_km, 1),
        "buildings": len(sel["buildings"]),
        "population": int(pop) if pop and pop.isdigit() else None,
        "floodplain": {"handMetres": FLOOD_HAND_M, "reachMetres": FLOOD_REACH_M},
    }
    write_json(OUT / "metrics.json", metrics)
    print("metrics", metrics)


TRANSLIT = OSM_NAMES["translit"]


def translit(s: str) -> str:
    out = []
    for ch in s:
        lo = ch.lower()
        r = TRANSLIT.get(lo, ch)
        out.append(r.capitalize() if ch != lo and r else r)
    return "".join(out)


def write_labels(c: Canvas, dem, features, sel) -> None:
    g = grid()
    cx, cy = g["width"] / 2, g["height"] / 2
    mpp = metres_per_px()

    def place(lon, lat):
        x, y = lonlat_to_px(lon, lat)
        px, py = x - g["px0"], y - g["py0"]
        if not (0 <= px < g["width"] and 0 <= py < g["height"]):
            return None
        return {"x": round((px - cx) * mpp), "z": round((py - cy) * mpp), "ground": round(float(dem[int(py), int(px)]), 1)}

    def names(tags):
        ru = re.sub(r"\s*\(\d+\)$", "", tags.get("name:ru") or tags.get("name"))
        en = tags.get("name:en") or translit(ru)
        return {"ru": ru, "en": re.sub(r"\s*\(\d+\)$", "", en.replace(" River", "").replace("Mount ", ""))}

    labels = []
    peaks = []
    for f in features:
        t = f["tags"]
        if f["kind"] == "point" and t.get("natural") == "peak" and t.get("name"):
            try:
                ele = float(t.get("ele", "").replace(",", "."))
            except ValueError:
                continue
            p = place(*f["lonlat"])
            if p and ele >= 700:
                peaks.append((ele, {"kind": "peak", "name": names(t), "ele": round(ele), **p}))
    kept = []
    for ele, lab in sorted(peaks, key=lambda e: -e[0]):
        if all(math.hypot(lab["x"] - k["x"], lab["z"] - k["z"]) > 2500 for k in kept):
            kept.append(lab)
    labels += kept[:14]

    for f in features:
        t = f["tags"]
        if f["kind"] != "point" or not t.get("name"):
            continue
        p = place(*f["lonlat"])
        if not p:
            continue
        if t.get("place") == "city":
            labels.append({"kind": "city", "name": names(t), **p})
        elif t.get("place") in ("village",):
            labels.append({"kind": "village", "name": names(t), **p})

    # Rivers: label at the point of the river nearest a chosen spot on its course.
    for name, (tlon, tlat) in RIVER_LABEL_AT.items():
        pieces = [f for f in sel["rivers"] if f["tags"].get("name") == name]
        if pieces:
            lon, lat = min((pt for f in pieces for pt in f["coords"]), key=lambda q: (q[0] - tlon) ** 2 + (q[1] - tlat) ** 2)
            p = place(lon, lat)
            if p:
                labels.append({"kind": "river", "name": names(pieces[0]["tags"]), **p})
    for f in sel["water_poly"]:
        if f["tags"].get("name") == OSM_NAMES["townPond"]:
            ring = f["rings"][0]["coords"]
            lon = sum(p[0] for p in ring) / len(ring)
            lat = sum(p[1] for p in ring) / len(ring)
            p = place(lon, lat)
            if p:
                labels.append({"kind": "pond", "name": {"ru": f["tags"]["name"], "en": "Beloretsk Pond"}, **p})
    write_json(OUT / "labels.json", labels)
    print(f"labels: {len(labels)}")


if __name__ == "__main__":
    main()
