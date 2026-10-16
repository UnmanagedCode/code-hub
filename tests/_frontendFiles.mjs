import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

// Every UI source file the build reads: index.html, public/** and src/**
// (.ts/.tsx/.css/.js), as [path relative to frontend/, text]. Tests
// (*.test.*, src/test/) are excluded unless asked for: they carry hostile
// strings on purpose.
export function sourceFiles({ tests = false } = {}) {
  const out = [['index.html', readFileSync(path.join(FRONTEND, 'index.html'), 'utf8')]];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(FRONTEND, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) {
        if (!tests && r === 'src/test') continue;
        walk(r);
      } else if (/\.(ts|tsx|css|js)$/.test(e.name) && (tests || !/\.test\./.test(e.name))) {
        out.push([r, readFileSync(path.join(FRONTEND, r), 'utf8')]);
      }
    }
  };
  walk('public');
  walk('src');
  return out;
}

// The tags of <head>, in order, as {tag, attrs} with the attribute text.
export function headTags(html) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
  return [...head.matchAll(/<(script|link|meta|title)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2] }));
}
