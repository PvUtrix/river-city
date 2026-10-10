// Repackages dist/ as a claude.ai artifact: the viewer wraps the page in its
// own doctype/head/body skeleton (charset + viewport included), so the page
// file must carry only its content, with <title> first.
//
//   pnpm build && pnpm artifact <out-dir>

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(root, 'artifact'));
const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');

const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0];
if (!title) throw new Error('dist/index.html has no <title>');
const page = html
  .replace(/<!doctype html>/i, '')
  .replace(/<\/?html[^>]*>|<\/?head>|<\/?body>/gi, '')
  .replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/gi, '')
  .replace(title, '')
  .replace(/\n\s*\n+/g, '\n')
  .trim();

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), `${title}\n${page}\n`);
cpSync(join(root, 'dist', 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(root, 'dist', 'data'), join(out, 'data'), { recursive: true });
console.log(`artifact page in ${out}`);
