# River City · Beloretsk

An imaginary plan for Beloretsk, in the Southern Urals (Republic of Bashkortostan),
redrawn around its rivers and mountains: room for the Belaya and the Nura, green
corridors along every stream, growth inward instead of outward. It ships as a
scroll-driven 3D site and as printable STL files of the same valley.

The ground is real: SRTM terrain and today's OpenStreetMap. The plan laid over it
is derived from that data by explicit rules (below), not drawn by hand, so every
number the site quotes can be traced back to a line in `pipeline/build_layers.py`.

**Live:** https://pvutrix.github.io/river-city/ (deployed by GitHub Pages on every push to `main`).

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # static site in dist/, works from any folder (relative base)
```

`public/data/` is committed, so the site runs without Python or network access.

## Rebuild the data

```bash
python3 -m venv .venv && .venv/bin/pip install numpy pillow scipy
pnpm data
```

Three steps, each cached under `pipeline/.cache/` (delete it to refresh):

| Step | Does | Writes |
| --- | --- | --- |
| `fetch_terrain.py` | Terrarium tiles at zoom 12 (~22.5 m/px), stitched and cropped | `terrain.png` (decimetres: red = high byte, green = low byte), `meta.json` |
| `fetch_osm.py` | Water, land use, buildings, roads, peaks via Overpass; stitches multipolygons itself | `.cache/features.json` |
| `build_layers.py` | Today's map, the plan zones, metrics, labels | `today.webp`, `plan.webp`, `zones.png`, `water_dem.png`, `metrics.json`, `labels.json` |

The extent is set once in `pipeline/common.py`: 53.86–54.08 N, 58.18–58.62 E,
about 28.8 × 24.5 km, holding the whole town and the ridges to its north-west.

## How the plan is derived

| Zone | Rule |
| --- | --- |
| Room for the river | Unbuilt ground less than 3.5 m above the Belaya or the Nura (height above nearest drainage, from the DEM) and within 1.2 km of it |
| Adaptive edge | The same floodplain where something is already built: kept, flood-adapted |
| Green finger | A 90 m corridor along every stream (135 m along smaller rivers) where it crosses open or built land; existing parks and cemeteries |
| Compact neighbourhood | Today's residential and commercial land; nothing new in forest or floodplain |
| Making district | Today's industrial land |
| Healing wetland | Sludge ponds, landfills, quarries |
| Riverside promenade | A 30 m band along water inside the town |
| Protected forest, meadows | Today's forest; grassland, meadow, farmland |

Zone ids are a contract between the pipeline and the site (`meta.json` carries
id → key → colour). Append new zones; never renumber.

## Print it

The site's last chapter builds an STL in the browser. For bigger prints, the CLI
splits the model into tiles that share their edge rows exactly:

```bash
pnpm print                                # one 250 mm piece, mountains ×2.5
pnpm print --width 800 --tile 250         # 800 mm model as tiles of at most 250 mm
pnpm print --exaggeration 3 --engrave 1   # steeper mountains, deeper rivers
```

Options: `--width`, `--exaggeration`, `--base`, `--engrave` (river cut depth),
`--min-river` (rivers thinner than this in print are widened to it), `--sample`
(surface detail), all in millimetres. Output goes to `print/` (git-ignored).
Every solid is closed (each edge shared by exactly two triangles) with outward
normals; rivers and the pond are cut into the surface for paint or a blue inlay.

## Sources and licences

- Code: [MIT](LICENSE).
- Terrain: SRTM, via [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS Open Data.
- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL 1.0.
  Everything in `public/data/` except `terrain.png` is derived from OSM and is
  therefore also ODbL; keep the attribution wherever the site or the data goes.
- The plan is a vision, not an official proposal.
