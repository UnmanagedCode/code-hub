// Pins: public/styles.css is dark-only, declares code-conductor's shell token
// names and font on :root, and references no custom property it neither
// declares there nor sets at runtime from public/*.js. Reads the stylesheet as
// text: there is no DOM here to resolve cascaded custom properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const publicDir = new URL('../public/', import.meta.url);
const css = readFileSync(new URL('styles.css', publicDir), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
const root = rootMatch ? rootMatch[1] : '';
const declared = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Custom properties the frontend sets inline (e.g. the per-app card hue).
const runtimeSet = new Set(
  readdirSync(publicDir)
    .filter((n) => n.endsWith('.js'))
    .flatMap((n) => [...readFileSync(new URL(n, publicDir), 'utf8')
      .matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map((m) => m[1])),
);

test(':root block exists', () => {
  assert.ok(rootMatch, 'styles.css has no :root block');
});

test('dark-only: no prefers-color-scheme query, :root declares color-scheme: dark', () => {
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(root, /(^|[;\s])color-scheme\s*:\s*dark\s*(;|$)/);
});

test("declares the host shell's token names on :root", () => {
  for (const name of ['--bg', '--panel', '--panel-2', '--text', '--muted', '--border',
    '--accent', '--green', '--amber', '--red']) {
    assert.ok(declared.has(name), `:root does not declare ${name}`);
  }
});

test(':root sets the host font stack at 14px', () => {
  assert.match(root, /(^|[;\s])font-family\s*:/);
  assert.match(root, /(^|[;\s])font-size\s*:\s*14px\s*(;|$)/);
});

test('every var(--name) used is declared on :root or set at runtime', () => {
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) {
    assert.ok(declared.has(name) || runtimeSet.has(name),
      `var(${name}) is neither declared on :root nor set via setProperty in public/*.js`);
  }
});
