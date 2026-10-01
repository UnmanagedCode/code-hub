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
  const family = root.match(/(?:^|[;\s])font-family\s*:\s*([^;]+)/);
  assert.ok(family, ':root declares no font-family');
  assert.equal(family[1].trim(), `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`);
  assert.match(root, /(^|[;\s])font-size\s*:\s*14px\s*(;|$)/);
});

// Flat `selector { body }` rules; an @media prelude never matches (its body
// holds a nested `{`), so its inner rules are picked up on their own.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }));

test('every disabled button styled cursor: pointer resolves to not-allowed', () => {
  // Covers only selectors that end in a `button` element; a class-only selector on a button is not seen.
  const isButton = (sel) => /(^|[\s>+~])button(?![\w-])[^\s>+~]*$/.test(sel);
  const pointer = rules
    .filter((r) => /(^|[;\s])cursor\s*:\s*pointer/.test(r.body))
    .flatMap((r) => r.selectors.filter(isButton));
  const notAllowed = new Set(rules
    .filter((r) => /(^|[;\s])cursor\s*:\s*not-allowed/.test(r.body))
    .flatMap((r) => r.selectors));
  assert.ok(pointer.length > 0);
  // The `:disabled` twin outranks its base by one pseudo-class, so it wins
  // whatever the source order.
  for (const sel of pointer) {
    assert.ok(notAllowed.has(`${sel}:disabled`),
      `\`${sel}\` sets cursor: pointer but no \`${sel}:disabled\` rule sets cursor: not-allowed`);
  }
});

test('every var(--name) used is declared on :root or set at runtime', () => {
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) {
    assert.ok(declared.has(name) || runtimeSet.has(name),
      `var(${name}) is neither declared on :root nor set via setProperty in public/*.js`);
  }
});
