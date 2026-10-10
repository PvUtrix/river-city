import en from './locales/en.json';
import ru from './locales/ru.json';

export type Lang = 'en' | 'ru';
export type Dict = typeof en;
export type Vars = Record<string, string | number>;

const dicts: Record<Lang, Dict> = { en, ru };
const KEY = 'river-city:lang';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    // storage blocked: fall through to the browser language
  }
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let lang: Lang = initial();

export const getLang = (): Lang => lang;

export function setLang(next: Lang): void {
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // a remembered language is a convenience only
  }
  document.documentElement.lang = next;
}

export const dict = (): Dict => dicts[lang];

export function fill(text: string, vars: Vars = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function number(n: number, digits = 0): string {
  return n.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
