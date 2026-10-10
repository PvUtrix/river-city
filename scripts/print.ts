// Writes printable STL files of the valley, split into tiles for big prints.
//
//   pnpm print                               one 250 mm piece
//   pnpm print --width 800 --tile 250        an 800 mm model as tiles of at most 250 mm
//   pnpm print --exaggeration 3 --engrave 1  steeper mountains, deeper rivers
//
// Files land in print/ (git-ignored). Tiles share their edge rows exactly, so
// they butt together without a seam step.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { buildSolid, DEFAULT_PRINT, planPrint, toBinarySTL, type PrintOptions, type PrintSource } from '../src/print/mesh';

const root = resolve(import.meta.dirname, '..');
const data = join(root, 'public', 'data');

function args(): { opt: PrintOptions; tileMm: number; out: string } {
  const a = process.argv.slice(2);
  const get = (name: string) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? Number(a[i + 1]) : undefined;
  };
  const opt: PrintOptions = {
    widthMm: get('width') ?? DEFAULT_PRINT.widthMm,
    exaggeration: get('exaggeration') ?? DEFAULT_PRINT.exaggeration,
    baseMm: get('base') ?? DEFAULT_PRINT.baseMm,
    engraveMm: get('engrave') ?? DEFAULT_PRINT.engraveMm,
    minRiverMm: get('min-river') ?? DEFAULT_PRINT.minRiverMm,
    sampleMm: get('sample') ?? DEFAULT_PRINT.sampleMm,
  };
  for (const [k, v] of Object.entries(opt)) if (!Number.isFinite(v) || v < 0) throw new Error(`bad --${k}`);
  return { opt, tileMm: get('tile') ?? Infinity, out: join(root, 'print') };
}

function load(): PrintSource {
  const meta = JSON.parse(readFileSync(join(data, 'meta.json'), 'utf8'));
  const terrain = PNG.sync.read(readFileSync(join(data, 'terrain.png')));
  const dem = new Float32Array(terrain.width * terrain.height);
  for (let i = 0; i < dem.length; i++) dem[i] = (terrain.data[i * 4] * 256 + terrain.data[i * 4 + 1]) / 10;
  const png = PNG.sync.read(readFileSync(join(data, 'water_dem.png')));
  const water = new Uint8Array(png.width * png.height);
  for (let i = 0; i < water.length; i++) water[i] = png.data[i * 4];
  return { dem, water, width: meta.width, height: meta.height, metresPerPx: meta.metresPerPx };
}

const { opt, tileMm, out } = args();
const src = load();
const whole = planPrint(src, opt);
const cols = Math.max(1, Math.ceil(whole.widthMm / tileMm));
const rows = Math.max(1, Math.ceil(whole.heightMm / tileMm));
mkdirSync(out, { recursive: true });
console.log(
  `${whole.widthMm} x ${whole.heightMm.toFixed(0)} mm, scale 1:${whole.scaleDenominator}, ` +
    `up to ${whole.maxZMm.toFixed(1)} mm tall, ${cols} x ${rows} tile(s)`,
);
for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    const tile = cols * rows > 1 ? { col, row, cols, rows } : undefined;
    const tris = buildSolid(src, opt, tile);
    const name = tile
      ? `river-city-${opt.widthMm}mm-r${row + 1}c${col + 1}.stl`
      : `river-city-${opt.widthMm}mm-x${opt.exaggeration}.stl`;
    writeFileSync(join(out, name), Buffer.from(toBinarySTL(tris)));
    console.log(`  ${name}: ${(tris.length / 9).toLocaleString('en-GB')} triangles`);
  }
}
