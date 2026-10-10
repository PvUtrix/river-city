// Builds a watertight, printable solid of the valley from the heightmap.
// Shared by the in-page download and scripts/print.ts (tiles for big prints),
// so it must not touch the DOM.
//
// Output units are millimetres, x east, y north, z up, with the model's
// south-west corner at the origin (or each tile's own corner).

export interface PrintSource {
  dem: Float32Array; // metres, row 0 = north
  water: Uint8Array; // non-zero = river or pond, same grid as dem
  width: number;
  height: number;
  metresPerPx: number;
}

export interface PrintOptions {
  widthMm: number;
  exaggeration: number;
  baseMm: number;
  /** How deep rivers and the pond are cut into the surface; 0 for none. */
  engraveMm: number;
  /** Rivers narrower than this in print are widened to it, so a nozzle can draw them. */
  minRiverMm: number;
  /** Distance between surface samples. */
  sampleMm: number;
}

export const DEFAULT_PRINT: PrintOptions = {
  widthMm: 250,
  exaggeration: 2.5,
  baseMm: 4,
  engraveMm: 0.6,
  minRiverMm: 1.2,
  sampleMm: 0.5,
};

export interface PrintPlan {
  nx: number;
  ny: number;
  widthMm: number;
  heightMm: number;
  mmPerMetre: number;
  scaleDenominator: number;
  maxZMm: number;
  triangles: number;
}

export interface Tile {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export function planPrint(src: PrintSource, opt: PrintOptions, tile?: Tile): PrintPlan {
  const mmPerMetre = opt.widthMm / (src.width * src.metresPerPx);
  const heightMm = src.height * src.metresPerPx * mmPerMetre;
  const nx = Math.max(2, Math.round(opt.widthMm / opt.sampleMm) + 1);
  const ny = Math.max(2, Math.round(heightMm / opt.sampleMm) + 1);
  let min = Infinity;
  let max = -Infinity;
  for (const e of src.dem) {
    if (e < min) min = e;
    if (e > max) max = e;
  }
  const [tx, ty] = tile ? tileCounts(nx, ny, tile) : [nx, ny];
  return {
    nx,
    ny,
    widthMm: opt.widthMm,
    heightMm,
    mmPerMetre,
    scaleDenominator: Math.round(1000 / mmPerMetre),
    maxZMm: opt.baseMm + (max - min) * mmPerMetre * opt.exaggeration,
    triangles: 2 * (tx - 1) * (ty - 1) + 4 * (tx - 1 + ty - 1) + 2 * (tx - 1 + ty - 1),
  };
}

function tileRange(n: number, i: number, count: number): [number, number] {
  return [Math.floor((i * (n - 1)) / count), Math.floor(((i + 1) * (n - 1)) / count)];
}

function tileCounts(nx: number, ny: number, t: Tile): [number, number] {
  const [x0, x1] = tileRange(nx, t.col, t.cols);
  const [y0, y1] = tileRange(ny, t.row, t.rows);
  return [x1 - x0 + 1, y1 - y0 + 1];
}

/** Square max-filter dilation, separable. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = mask[y * w + k];
      tmp[y * w + x] = v ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Triangles as a flat array of vertex positions, 9 floats per triangle. */
export function buildSolid(src: PrintSource, opt: PrintOptions, tile?: Tile): Float32Array {
  const plan = planPrint(src, opt, tile);
  const { nx, ny, mmPerMetre } = plan;
  const { width: W, height: H, dem } = src;
  let minElev = Infinity;
  for (const e of dem) if (e < minElev) minElev = e;

  const halfRiverPx = opt.minRiverMm / 2 / (src.metresPerPx * mmPerMetre);
  const water = opt.engraveMm > 0 ? dilate(src.water, W, H, Math.max(0, Math.ceil(halfRiverPx - 0.5))) : null;

  const [gx0, gx1] = tile ? tileRange(nx, tile.col, tile.cols) : [0, nx - 1];
  const [gy0, gy1] = tile ? tileRange(ny, tile.row, tile.rows) : [0, ny - 1];
  const cw = gx1 - gx0 + 1;
  const ch = gy1 - gy0 + 1;
  const stepX = opt.widthMm / (nx - 1);
  const stepY = plan.heightMm / (ny - 1);

  // Surface heights on the (tile's part of the) global grid. Grid row 0 is north.
  const z = new Float32Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    const v = ((gy0 + j) / (ny - 1)) * (H - 1);
    const y0 = Math.floor(v);
    const y1 = Math.min(H - 1, y0 + 1);
    const fy = v - y0;
    for (let i = 0; i < cw; i++) {
      const u = ((gx0 + i) / (nx - 1)) * (W - 1);
      const x0 = Math.floor(u);
      const x1 = Math.min(W - 1, x0 + 1);
      const fx = u - x0;
      const e =
        dem[y0 * W + x0] * (1 - fx) * (1 - fy) +
        dem[y0 * W + x1] * fx * (1 - fy) +
        dem[y1 * W + x0] * (1 - fx) * fy +
        dem[y1 * W + x1] * fx * fy;
      let h = opt.baseMm + (e - minElev) * mmPerMetre * opt.exaggeration;
      if (water && water[Math.round(v) * W + Math.round(u)]) h = Math.max(opt.baseMm * 0.5, h - opt.engraveMm);
      z[j * cw + i] = h;
    }
  }

  const X = (i: number) => i * stepX;
  const Y = (j: number) => (ch - 1 - j) * stepY; // north row at the top
  const tris = new Float32Array(planPrint(src, opt, tile).triangles * 9);
  let n = 0;
  const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => {
    tris[n++] = ax; tris[n++] = ay; tris[n++] = az;
    tris[n++] = bx; tris[n++] = by; tris[n++] = bz;
    tris[n++] = cx; tris[n++] = cy; tris[n++] = cz;
  };

  // Top surface, counter-clockwise seen from above.
  for (let j = 0; j < ch - 1; j++) {
    for (let i = 0; i < cw - 1; i++) {
      const a = z[j * cw + i];
      const b = z[j * cw + i + 1];
      const c = z[(j + 1) * cw + i];
      const d = z[(j + 1) * cw + i + 1];
      tri(X(i), Y(j + 1), c, X(i + 1), Y(j + 1), d, X(i + 1), Y(j), b);
      tri(X(i), Y(j + 1), c, X(i + 1), Y(j), b, X(i), Y(j), a);
    }
  }

  // Perimeter walked so that (direction × up) points outward: south edge
  // eastward, east edge northward, north edge westward, west edge southward.
  const ring: [number, number, number][] = [];
  for (let i = 0; i < cw - 1; i++) ring.push([X(i), Y(ch - 1), z[(ch - 1) * cw + i]]);
  for (let j = ch - 1; j > 0; j--) ring.push([X(cw - 1), Y(j), z[j * cw + cw - 1]]);
  for (let i = cw - 1; i > 0; i--) ring.push([X(i), Y(0), z[i]]);
  for (let j = 0; j < ch - 1; j++) ring.push([X(0), Y(j), z[j * cw]]);

  for (let k = 0; k < ring.length; k++) {
    const [ax, ay, az] = ring[k];
    const [bx, by, bz] = ring[(k + 1) % ring.length];
    tri(ax, ay, 0, bx, by, 0, bx, by, bz);
    tri(ax, ay, 0, bx, by, bz, ax, ay, az);
  }

  // Bottom: a fan from the centre over every perimeter vertex, facing down,
  // so the bottom shares each wall's edges and the solid stays watertight.
  const mx = X(cw - 1) / 2;
  const my = Y(0) / 2;
  for (let k = 0; k < ring.length; k++) {
    const [ax, ay] = ring[k];
    const [bx, by] = ring[(k + 1) % ring.length];
    tri(mx, my, 0, bx, by, 0, ax, ay, 0);
  }
  return n === tris.length ? tris : tris.subarray(0, n);
}

export function toBinarySTL(tris: Float32Array, header = 'River City - Beloretsk'): ArrayBuffer {
  const count = tris.length / 9;
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const p = t * 9;
    const ux = tris[p + 3] - tris[p], uy = tris[p + 4] - tris[p + 1], uz = tris[p + 5] - tris[p + 2];
    const vx = tris[p + 6] - tris[p], vy = tris[p + 7] - tris[p + 1], vz = tris[p + 8] - tris[p + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++) {
      view.setFloat32(o, tris[p + k], true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
