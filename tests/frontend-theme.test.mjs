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
// The CSS named colours (CSS Color 4), matched only as whole tokens in a value position.
const NAMED = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
  + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen '
  + 'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray '
  + 'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia '
  + 'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender '
  + 'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink '
  + 'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta '
  + 'maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '
  + 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
  + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red '
  + 'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
  + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ').join('|');
// `_` is Tailwind's space in an arbitrary value, so it separates tokens like any non-name character.
const WORD = String.raw`(?<![A-Za-z0-9-])(?:${NAMED})(?![A-Za-z0-9-])`;
// (a) a named colour anywhere inside a utility's arbitrary value: `bg-[linear-gradient(red,blue)]`.
const IN_BRACKET = String.raw`-\[[^\]\s]*?${WORD}[^\]\s]*\]`;
// (b) a named colour in the value of a property that takes a colour: `color: red`, `border: 1px solid tomato`.
const COLOR_PROP = String.raw`(?<![\w-])(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|box-shadow|text-shadow|column-rule(?:-color)?)\s*:\s*[^;{}\n]*?${WORD}`;
const LITERAL = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(|\\boklch\\(|\\b(?:${COLOR_UTIL})-(?:(?:${PALETTE})\\b|${ARBITRARY})|${IN_BRACKET}|${COLOR_PROP}`, 'i');
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
    'ring-[rgb(1,2,3)]', 'color: #abc', 'rgba(0,0,0,.5)', 'oklch(0.2 0 0)',
    'bg-[linear-gradient(red,blue)]', 'bg-[radial-gradient(circle,_tomato_0%,_transparent)]', 'footer { color: red; }',
    'border: 1px solid Tomato;', 'background-color:navy', "{ color: 'white' }"]) {
    assert.match(hit, LITERAL, hit);
  }
  for (const miss of ['text-muted-foreground', 'bg-success/15', 'focus-visible:ring-[3px]', 'text-[13px]', 'bg-[var(--card)]', 'max-w-72', 'border-l-4',
    'required', 'bored', 'the red route', 'data-[state=open]:rotate-180', 'grid-cols-[3rem_1fr]', 'transition-[color,box-shadow]',
    "label: 'Status'", 'color: var(--foreground);', 'border: 1px solid var(--border)', 'background: transparent', 'redirect: true',
    "colorScheme: 'dark'", 'bg-[url(./bored.png)]', '--font-sans: Geist, sans-serif;']) {
    assert.doesNotMatch(miss, LITERAL, miss);
  }
});

// Set on <html> by cc's plugin bridge (/pluginBridge.js) when embedded and unset standalone, so every use needs a fallback.
const HOST_PROPS = new Set(['--cc-session-width']);
// The `var(--x…)` heads in a single own frontend file that neither name a declared token nor a host property given a fallback.
const badVars = (src, tokens) => [...strip(src).matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)]
  .filter(([, name, comma]) => !(tokens.has(name) || (HOST_PROPS.has(name) && comma)))
  .map(([head]) => head);

// Invariant: a host property passes only with a fallback; an unknown name fails with or without one; a declared token passes.
test('badVars: host property needs a fallback, unknown names always fail', () => {
  const tokens = new Set(['--card']);
  assert.deepEqual(badVars('max-w-[var(--cc-session-width)]', tokens), ['var(--cc-session-width']);
  assert.deepEqual(badVars('var(--nope)', tokens), ['var(--nope']);
  assert.deepEqual(badVars('var(--nope,1px)', tokens), ['var(--nope,']);
  assert.deepEqual(badVars('max-w-[var(--cc-session-width,42rem)]', tokens), []);
  assert.deepEqual(badVars('bg-[var(--card)]', tokens), []);
});

// Invariant: every var(--x) in own frontend files (CSS, code, public/, index.html) names a token that is declared — by the fallback (cc's tokens,
// both modes) or by the @theme inline map (or is a HOST_PROPS entry with a fallback) — so no reference silently resolves to nothing standalone.
test('every var(--x) in own CSS and code resolves to a declared token, or a host property given a fallback', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1];
  const tokens = new Set([...declared(block(fallback, ':root')), ...declared(block(fallback, '.dark')), ...declared(theme)]);
  // All own frontend files: index.html, public/** and src/**, minus the copied components.
  const files = sourceFiles().filter(([n]) => !n.startsWith('src/components/ui/'));
  assert.ok(files.some(([n]) => n === 'public/theme-init.js') && files.some(([n]) => n === 'index.html'), 'scans public/ and index.html');
  let seen = 0;
  for (const [n, src] of files) {
    seen += [...strip(src).matchAll(/var\(\s*--[\w-]+/g)].length;
    assert.deepEqual(badVars(src, tokens), [], `${n}: undeclared token, or host property without a fallback`);
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
