import './style.css';
import { loadSiteData, type SiteData } from './data';
import { dict, fill, getLang, number, setLang, type Vars } from './i18n';
import { renderPrinter } from './print/panel';
import { RiverScene, type View } from './scene';

interface Chapter {
  id: keyof ReturnType<typeof dict>['chapters'];
  mix: 0 | 1;
  highlight?: string[];
  view: View;
}

// Camera stops in model kilometres (x east, y up, z south of the model centre).
// The town centre is near (0.6, 0.17, 0.2); the pond at (0.7, 0.1, -1.5); the
// Nura meets the Belaya at (-0.8, 0.1, 2.4); Malinovaya is at (-7.1, 1.2, -5.6).
const CHAPTERS: Chapter[] = [
  { id: 'intro', mix: 1, view: { target: [0.3, 0.1, 0.4], position: [6, 15.5, 29] } },
  { id: 'place', mix: 0, view: { target: [0.2, 0.12, -0.6], position: [4.2, 5.2, 8.2] } },
  { id: 'river', mix: 1, highlight: ['riverRoom', 'adaptiveEdge', 'water'], view: { target: [-1.6, 0.1, 3.4], position: [5.5, 6.2, 11.5] } },
  { id: 'fingers', mix: 1, highlight: ['greenFinger', 'water', 'promenade'], view: { target: [1.1, 0.15, 0.9], position: [-1.6, 3.2, 5.2] } },
  { id: 'inward', mix: 1, highlight: ['neighbourhood', 'building', 'spine', 'street'], view: { target: [1.6, 0.15, 0.9], position: [6.8, 5.6, 6.6] } },
  { id: 'pond', mix: 1, highlight: ['promenade', 'making', 'water'], view: { target: [0.5, 0.1, -1.2], position: [-2.9, 3.3, 2.9] } },
  { id: 'heal', mix: 1, highlight: ['remediation'], view: { target: [-0.9, 0.12, 0.2], position: [6.2, 7.2, 8.4] } },
  { id: 'ring', mix: 1, highlight: ['trail', 'forest'], view: { target: [-5.2, 0.6, -4.2], position: [3, 6.8, 4.8] } },
  { id: 'numbers', mix: 1, view: { target: [0, 0.2, 0.6], position: [0.01, 25, 13] } },
  { id: 'print', mix: 0, view: { target: [0, 0.1, 0], position: [-21, 15, 23] } },
  { id: 'about', mix: 1, view: { target: [0, 0.1, 0], position: [21, 13, 24] } },
];

const LEGEND = ['riverRoom', 'adaptiveEdge', 'greenFinger', 'promenade', 'forest', 'meadow', 'neighbourhood', 'making', 'remediation', 'spine', 'trail', 'water'];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function storyVars(data: SiteData): Vars {
  const a = data.metrics.areaHa;
  const total = Object.values(a).reduce((s, v) => s + v, 0);
  const pct = (v: number) => number((v / total) * 100);
  const peak = (en: string) => data.labels.find((l) => l.kind === 'peak' && l.name.en === en)?.ele ?? 0;
  const ha = (v: number) => number(Math.round(v));
  const pop = data.metrics.population ?? 0;
  const { metresPerPx: mpp, width, height } = data.meta;
  return {
    population: number(Math.round(pop / 1000) * 1000),
    kirel: number(peak('Kirel')),
    malinovaya: number(peak('Malinovaya')),
    forestPct: pct(a.forest),
    urbanPct: pct(a.neighbourhood + a.adaptiveEdge + a.making + a.building + a.street),
    modelW: number((width * mpp) / 1000),
    modelH: number((height * mpp) / 1000),
    hand: number(data.metrics.floodplain.handMetres, 1),
    reach: number(data.metrics.floodplain.reachMetres / 1000, 1),
    riverRoom: ha(a.riverRoom),
    adaptive: ha(a.adaptiveEdge),
    fingerKm: number(Math.round(data.metrics.greenFingerKm)),
    walk: data.metrics.homesNearGreenPct.walkMetres,
    homesToday: number(data.metrics.homesNearGreenPct.today, 1),
    homesPlan: number(data.metrics.homesNearGreenPct.plan, 1),
    neighbourhood: ha(a.neighbourhood),
    promenade: ha(a.promenade),
    making: ha(a.making),
    remediation: ha(a.remediation),
    forest: ha(a.forest),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderStory(data: SiteData, vars: Vars): void {
  const story = $('#story');
  story.replaceChildren();
  const t = dict();
  for (const ch of CHAPTERS) {
    const c = t.chapters[ch.id] as { kicker: string; title: string; body?: string[]; stats?: Record<string, string>; note?: string };
    const section = el('section', `chapter chapter--${ch.id}`);
    section.dataset.chapter = ch.id;
    section.id = ch.id;
    const card = el('article', 'card');
    card.append(el('p', 'kicker', c.kicker), el(ch.id === 'intro' ? 'h1' : 'h2', 'title', c.title));
    for (const p of c.body ?? []) card.append(el('p', 'body', fill(p, vars)));

    if (ch.id === 'numbers' && c.stats) {
      const grid = el('div', 'stats');
      const stat = (value: string, unit: string, label: string) => {
        const s = el('div', 'stat');
        const v = el('p', 'stat__value', value);
        if (unit) v.append(el('span', 'stat__unit', unit));
        s.append(v, el('p', 'stat__label', fill(label, vars)));
        grid.append(s);
      };
      stat(String(vars.riverRoom), '', c.stats.riverRoom);
      stat(String(vars.fingerKm), '', c.stats.fingerKm);
      stat(String(vars.homesPlan), '%', c.stats.homes);
      stat('0', '', c.stats.zero);
      card.append(grid);
      if (c.note) card.append(el('p', 'note', c.note));
    }
    if (ch.id === 'print') card.append(renderPrinter(data));
    if (ch.id === 'intro') card.append(el('p', 'scroll-hint', t.ui.scroll));
    section.append(card);
    story.append(section);
  }
}

function renderChrome(): void {
  const t = dict();
  $('#brand-name').textContent = t.ui.brand;
  $('#brand-place').textContent = t.ui.place;
  $('#mode-today').textContent = t.ui.today;
  $('#mode-plan').textContent = t.ui.plan;
  $('#go-print').textContent = t.ui.print;
  const lang = $('#lang');
  lang.textContent = t.ui.langSwitch;
  lang.setAttribute('aria-label', t.ui.langSwitchLabel);
  $('#legend-title').textContent = t.ui.legend;
  document.title = t.meta.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', t.meta.description);
}

function renderLegend(data: SiteData): void {
  const list = $('#legend-list');
  list.replaceChildren();
  for (const key of LEGEND) {
    const entry = Object.values(data.meta.zones).find((z) => z.key === key);
    if (!entry) continue;
    const li = el('li');
    const sw = el('span', `swatch swatch--${key}`);
    sw.style.setProperty('--swatch', entry.colour);
    li.append(sw, el('span', '', dict().zones[key as keyof ReturnType<typeof dict>['zones']]));
    list.append(li);
  }
}

async function main(): Promise<void> {
  setLang(getLang());
  renderChrome();
  $('#loader-text').textContent = dict().ui.loading;

  const data = await loadSiteData();
  performance.mark('river-city:data');
  const scene = await RiverScene.create($('#scene'), $('#labels'), data);
  performance.mark('river-city:scene');
  const vars = () => storyVars(data);

  let active: Chapter = CHAPTERS[0];
  let manualMix = false;

  const setMode = (mix: number) => {
    scene.setMix(mix);
    document.body.classList.toggle('mode-plan', mix > 0.5);
    $('#mode-today').setAttribute('aria-pressed', String(mix < 0.5));
    $('#mode-plan').setAttribute('aria-pressed', String(mix > 0.5));
  };

  const enter = (ch: Chapter) => {
    if (ch === active && document.body.dataset.chapter === ch.id) return;
    active = ch;
    document.body.dataset.chapter = ch.id;
    manualMix = false;
    setMode(ch.mix);
    scene.highlight(ch.highlight ?? null);
    scene.flyTo(ch.view);
  };

  const frame = () => {
    const wide = innerWidth >= 900;
    const card = document.querySelector<HTMLElement>('.chapter .card');
    scene.setFraming(wide ? (card?.getBoundingClientRect().right ?? 0) : 0, wide ? 0 : Math.round(innerHeight * 0.38));
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const ch = CHAPTERS.find((c) => c.id === (e.target as HTMLElement).dataset.chapter);
        if (ch) enter(ch);
      }
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );

  const explore = $('#explore');
  if (innerWidth < 900) $<HTMLDetailsElement>('.legend details').open = false;

  const render = () => {
    renderChrome();
    renderStory(data, vars());
    renderLegend(data);
    scene.setLanguage(getLang(), dict().ui.metre);
    explore.textContent = document.body.classList.contains('exploring') ? dict().ui.backToStory : dict().ui.explore;
    document.querySelectorAll('.chapter').forEach((s) => observer.observe(s));
    frame();
  };
  render();
  addEventListener('resize', frame);

  $('#mode-today').addEventListener('click', () => {
    manualMix = true;
    setMode(0);
  });
  $('#mode-plan').addEventListener('click', () => {
    manualMix = true;
    setMode(1);
  });
  $('#lang').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'ru' : 'en');
    observer.disconnect();
    render();
  });
  $('#go-print').addEventListener('click', () => document.getElementById('print')?.scrollIntoView({ behavior: 'smooth' }));

  const setExploring = (on: boolean) => {
    document.body.classList.toggle('exploring', on);
    scene.setExploring(on);
    explore.setAttribute('aria-pressed', String(on));
    explore.textContent = on ? dict().ui.backToStory : dict().ui.explore;
    scene.refreshFraming();
    if (on) scene.highlight(null);
    else {
      scene.highlight(active.highlight ?? null);
      scene.flyTo(active.view, 1600);
      if (!manualMix) setMode(active.mix);
    }
  };
  setExploring(false);
  explore.addEventListener('click', () => setExploring(!document.body.classList.contains('exploring')));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('exploring')) setExploring(false);
  });
  $('#zoom-in').addEventListener('click', () => scene.zoom(0.7));
  $('#zoom-out').addEventListener('click', () => scene.zoom(1.4));

  const tip = $('#tooltip');
  scene.onHover = (h) => {
    if (!h) {
      tip.hidden = true;
      return;
    }
    const t = dict();
    const zone = scene.mix > 0.5 && !['terrain', 'building', 'street'].includes(h.zone) ? t.zones[h.zone as keyof typeof t.zones] : '';
    tip.replaceChildren();
    if (zone) tip.append(el('strong', '', zone));
    tip.append(el('span', '', fill(t.ui.elevation, { m: number(Math.round(h.elevation)) })));
    tip.style.transform = `translate(${h.clientX + 14}px, ${h.clientY + 14}px)`;
    tip.hidden = false;
  };

  enter(CHAPTERS[0]);
  document.body.classList.add('ready');
  performance.mark('river-city:ready');
}

main().catch((err: unknown) => {
  console.error(err);
  const t = $('#loader-text');
  t.textContent = `Could not load the model: ${err instanceof Error ? err.message : String(err)}`;
});
