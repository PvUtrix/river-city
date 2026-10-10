import { dict, fill, number } from '../i18n';
import type { SiteData } from '../data';
import { buildSolid, DEFAULT_PRINT, planPrint, toBinarySTL, type PrintOptions, type PrintSource } from './mesh';
import { zipOne } from './zip';

// Inside the claude.ai artifact viewer a page cannot start a download itself;
// it asks the viewer through the `downloads` capability instead.
interface ArtifactHost {
  use(name: 'downloads'): Promise<{ save(r: { filename: string; data: Blob }): Promise<{ status: string }> } | null>;
}
const host = (window as unknown as { claude?: ArtifactHost }).claude;

/** Hands the file to the viewer; returns a message to show, or null. */
async function offer(stl: ArrayBuffer, filename: string): Promise<string | null> {
  if (!host) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    return null;
  }
  const downloads = await host.use('downloads');
  if (!downloads) return dict().printer.unavailable;
  try {
    await downloads.save({ filename: filename.replace(/\.stl$/, '.zip'), data: zipOne(filename, new Uint8Array(stl)) });
    return null;
  } catch (err) {
    return (err as { code?: string }).code === 'declined' ? null : dict().printer.unavailable;
  }
}

interface Control {
  key: keyof PrintOptions;
  label: () => string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const CONTROLS: Control[] = [
  { key: 'widthMm', label: () => dict().printer.width, min: 120, max: 400, step: 10, unit: 'mm' },
  { key: 'exaggeration', label: () => dict().printer.exaggeration, min: 1, max: 4, step: 0.25, unit: '×' },
  { key: 'baseMm', label: () => dict().printer.base, min: 2, max: 12, step: 1, unit: 'mm' },
  { key: 'engraveMm', label: () => dict().printer.engrave, min: 0, max: 2, step: 0.2, unit: 'mm' },
  { key: 'sampleMm', label: () => dict().printer.detail, min: 0.3, max: 1, step: 0.1, unit: 'mm' },
];

const options: PrintOptions = { ...DEFAULT_PRINT };

/** The in-page STL builder that sits in the "Print the valley" chapter. */
export function renderPrinter(data: SiteData): HTMLElement {
  const src: PrintSource = {
    dem: data.dem,
    water: data.water,
    width: data.meta.width,
    height: data.meta.height,
    metresPerPx: data.meta.metresPerPx,
  };
  const root = document.createElement('div');
  root.className = 'printer';
  const summary = document.createElement('p');
  summary.className = 'printer__summary';

  const update = () => {
    const p = planPrint(src, options);
    const t = dict().printer;
    summary.replaceChildren(
      line(fill(t.scale, { n: number(p.scaleDenominator) })),
      line(fill(t.size, { w: number(p.widthMm), h: number(p.heightMm), z: number(p.maxZMm, 1) })),
      line(fill(t.cost, { tris: number(p.triangles), mb: number((84 + p.triangles * 50) / 1e6, 1) })),
    );
  };

  for (const c of CONTROLS) {
    const row = document.createElement('label');
    row.className = 'printer__row';
    const name = document.createElement('span');
    name.textContent = c.label();
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(options[c.key]);
    const value = document.createElement('output');
    const show = () => (value.textContent = `${number(options[c.key], c.step < 1 ? 1 : 0)} ${c.unit}`);
    input.addEventListener('input', () => {
      options[c.key] = Number(input.value);
      show();
      update();
    });
    show();
    row.append(name, input, value);
    root.append(row);
  }

  const label = () => (host ? dict().printer.downloadZip : dict().printer.download);
  const button = document.createElement('button');
  button.className = 'button button--primary';
  button.type = 'button';
  button.textContent = label();
  const status = document.createElement('p');
  status.className = 'printer__tip';
  status.setAttribute('role', 'status');
  status.hidden = true;
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = dict().printer.building;
    status.hidden = true;
    // Let the label repaint before the (synchronous) mesh build.
    setTimeout(async () => {
      try {
        const stl = toBinarySTL(buildSolid(src, options));
        const message = await offer(stl, `river-city-beloretsk-${options.widthMm}mm-x${options.exaggeration}.stl`);
        if (message) {
          status.textContent = message;
          status.hidden = false;
        }
      } finally {
        button.disabled = false;
        button.textContent = label();
      }
    }, 30);
  });

  const tip = document.createElement('p');
  tip.className = 'printer__tip';
  tip.textContent = dict().printer.tiles;

  root.append(summary, button, status, tip);
  update();
  return root;
}

function line(text: string): HTMLElement {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}
