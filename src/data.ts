// Loads what pipeline/build_layers.py writes to public/data.

export interface Meta {
  width: number;
  height: number;
  metresPerPx: number;
  bounds: { west: number; south: number; east: number; north: number };
  elevation: { min: number; max: number };
  texture: { width: number; height: number; scale: number; metresPerPx: number };
  zones: Record<string, { key: string; colour: string }>;
}

export interface Label {
  kind: 'peak' | 'city' | 'village' | 'river' | 'pond';
  name: { en: string; ru: string };
  ele?: number;
  x: number; // metres east of the model centre
  z: number; // metres south of the model centre
  ground: number; // metres above sea level
}

export interface Metrics {
  areaHa: Record<string, number>;
  homesNearGreenPct: { today: number; plan: number; walkMetres: number };
  greenFingerKm: number;
  buildings: number;
  population: number | null;
  floodplain: { handMetres: number; reachMetres: number };
}

export interface Zones {
  /** Zone id per pixel, row 0 = north, at half the texture resolution. */
  ids: Uint8Array;
  width: number;
  height: number;
}

export interface SiteData {
  meta: Meta;
  dem: Float32Array; // metres, row 0 = north
  water: Uint8Array; // 0/255 at DEM resolution
  labels: Label[];
  metrics: Metrics;
  zones: Zones;
  todayUrl: string;
  planUrl: string;
}

const base = `${import.meta.env.BASE_URL}data/`;

async function json<T>(name: string): Promise<T> {
  const res = await fetch(base + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// createImageBitmap rather than <img>.decode(): decode() waits until a background
// tab becomes visible, and 'none' conversions keep zone ids exact.
async function image(name: string): Promise<ImageBitmap> {
  const res = await fetch(base + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

/** Nearest-neighbour pixel read, so zone ids and height bytes survive unblended. */
function readPixels(img: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, width, height);
  img.close();
  return ctx.getImageData(0, 0, width, height).data;
}

function readChannel(img: ImageBitmap, width: number, height: number): Uint8Array {
  const rgba = readPixels(img, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
  return out;
}

export async function loadSiteData(): Promise<SiteData> {
  const [meta, labels, metrics, terrain, zonesImg, waterImg] = await Promise.all([
    json<Meta>('meta.json'),
    json<Label[]>('labels.json'),
    json<Metrics>('metrics.json'),
    image('terrain.png'),
    image('zones.png'),
    image('water_dem.png'),
  ]);
  if (!meta.texture || !meta.zones) throw new Error('meta.json has no texture or zones: run all three steps of pnpm data');
  // Decimetres as 16 bits: red is the high byte, green the low byte.
  const px = readPixels(terrain, meta.width, meta.height);
  const dem = new Float32Array(meta.width * meta.height);
  for (let i = 0; i < dem.length; i++) dem[i] = (px[i * 4] * 256 + px[i * 4 + 1]) / 10;

  const zw = Math.round(meta.texture.width / 2);
  const zh = Math.round(meta.texture.height / 2);
  return {
    meta,
    dem,
    water: readChannel(waterImg, meta.width, meta.height),
    labels,
    metrics,
    zones: { ids: readChannel(zonesImg, zw, zh), width: zw, height: zh },
    todayUrl: base + 'today.webp',
    planUrl: base + 'plan.webp',
  };
}
