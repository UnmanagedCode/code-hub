// Pins the theme wiring: cc's tokens with a standalone fallback for both
// modes, colours only through tokens, and no theme control of the plugin's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND, sourceFiles } from './_frontendFiles.mjs';

const read = (rel) => readFileSync(path.join(FRONTEND, rel), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const fallback = strip(read('src/cc-theme-fallback.css'));
const indexCss = strip(read('src/index.css'));

// The body of the first `<selector> {…}` block (no nested braces inside).
const block = (css, selector) => css.match(new RegExp(`(?:^|[\\s}])${selector.replace('.', '\\.')}\\s*\\{([^{}]*)\\}`))?.[1];
const declared = (body) => new Set([...(body ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Invariant: the fallback is one @layer base block (so cc's unlayered sheet wins embedded) declaring :root and .dark.
test('cc-theme-fallback.css is wrapped in @layer base and declares :root and .dark', () => {
  assert.match(fallback.trim(), /^@layer base \{[\s\S]*\}$/);
  assert.ok(declared(block(fallback, ':root')).size > 10, ':root tokens');
  assert.ok(declared(block(fallback, '.dark')).size > 10, '.dark tokens');
});

// Invariant: standalone, every token @theme inline maps resolves in light, and every colour token in dark too.
test('every @theme inline token is declared by the fallback, colours in both modes', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(theme, '@theme inline block');
  const light = declared(block(fallback, ':root'));
  const dark = declared(block(fallback, '.dark'));
  const used = [...theme.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
  assert.ok(used.length > 20);
  for (const [, name, value] of used) {
    for (const [, v] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      assert.ok(light.has(v), `${name}: var(${v}) not declared in :root`);
      if (name.startsWith('--color-')) assert.ok(dark.has(v), `${name}: var(${v}) not declared in .dark`);
    }
  }
});

// Invariant: index.css pulls in Tailwind, the animations, the fallback, and cc's class-based dark variant.
test('index.css imports and dark variant', () => {
  for (const imp of ['tailwindcss', 'tw-animate-css', './cc-theme-fallback.css']) {
    assert.match(indexCss, new RegExp(`@import ['"]${imp.replace(/[./]/g, '\\$&')}['"];`), imp);
  }
  assert.match(indexCss, /@custom-variant dark \(&:is\(\.dark \*\)\);/);
});

const PALETTE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white';
const COLOR_UTIL = 'bg|text|border(?:-[xytrblse])?|ring|fill|stroke|outline|decoration|shadow|from|via|to|divide|accent|caret';
// An arbitrary value that is a colour: `color:`-hinted, a hex, a colour function, or a bare keyword (`[red]`).
const ARBITRARY = String.raw`\[(?:color:[^\]]+|#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^\]]*\)|[a-zA-Z]+)\]`;
const LITERAL = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(|\\boklch\\(|\\b(?:${COLOR_UTIL})-(?:(?:${PALETTE})\\b|${ARBITRARY})`);
const own = sourceFiles().filter(([n]) => n.startsWith('src/') && !n.startsWith('src/components/ui/') && n !== 'src/cc-theme-fallback.css');

// Invariant: the plugin's own code uses colours only through the theme tokens; the card accent palette
// (lib/accent.ts, decoration) is the one named exception.
test('own code has no literal colours', () => {
  assert.ok(own.length > 10);
  for (const [n, src] of own) {
    if (n === 'src/lib/accent.ts') continue;
    assert.equal(LITERAL.test(src), false, `${n}: ${src.match(LITERAL)?.[0]}`);
  }
});

// Invariant: the literal-colour pattern catches palette names, raw colour values and arbitrary-value colours,
// and lets token utilities, arbitrary sizes and var() through.
test('the literal-colour pattern: what it catches and what it lets through', () => {
  for (const hit of ['text-red-500', 'border-l-sky-400', 'bg-[#fff]', 'text-[red]', 'text-[color:red]', 'dark:bg-[oklch(0.5_0.1_10)]',
    'ring-[rgb(1,2,3)]', 'color: #abc', 'rgba(0,0,0,.5)', 'oklch(0.2 0 0)']) {
    assert.match(hit, LITERAL, hit);
  }
  for (const miss of ['text-muted-foreground', 'bg-success/15', 'focus-visible:ring-[3px]', 'text-[13px]', 'bg-[var(--card)]', 'max-w-72', 'border-l-4']) {
    assert.doesNotMatch(miss, LITERAL, miss);
  }
});

// Invariant: every var(--x) in own CSS and code names a token that is declared — by the fallback (cc's tokens,
// both modes) or by the @theme inline map — so no reference silently resolves to nothing standalone.
test('every var(--x) in own CSS and code resolves to a declared token', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1];
  const tokens = new Set([...declared(block(fallback, ':root')), ...declared(block(fallback, '.dark')), ...declared(theme)]);
  const files = sourceFiles().filter(([n]) => n.startsWith('src/') && !n.startsWith('src/components/ui/'));
  let seen = 0;
  for (const [n, src] of files) {
    for (const [, name] of strip(src).matchAll(/var\(\s*(--[\w-]+)/g)) {
      seen += 1;
      assert.ok(tokens.has(name), `${n}: var(${name}) is not a declared token`);
    }
  }
  assert.ok(seen > 20, 'scanned the var() references');
});

// Invariant: the accent exemption covers only the left-border palette classes, nothing else literal.
test('lib/accent.ts names only left-border palette classes', () => {
  const src = own.find(([n]) => n === 'src/lib/accent.ts')[1];
  const literals = [...src.matchAll(new RegExp(LITERAL.source, 'g'))].map((m) => m[0]);
  assert.ok(literals.length > 0);
  for (const l of literals) assert.match(l, new RegExp(`^border-l-(?:${PALETTE})$`), l);
});

// Invariant: only public/theme-init.js (standalone) touches the dark class or data-cc-theme; cc's choice applies.
test('no theme control of the plugin\'s own', () => {
  const mutates = /classList\.(?:add|remove|toggle|replace)\(\s*['"]dark['"]|(?:set|remove|toggle)Attribute\(\s*['"]data-cc-theme/;
  for (const [n, src] of sourceFiles()) {
    if (n === 'public/theme-init.js') {
      assert.match(src, /classList\.toggle\('dark'/);
      continue;
    }
    assert.equal(mutates.test(src), false, `${n}: ${src.match(mutates)?.[0]}`);
  }
});
