// Source-scan guards over the UI: no HTML-string sinks, relative URLs only, no
// inline script or style, the host contract's <head> order, and the two
// chokepoints the CSP's 'unsafe-inline' styles rely on (links built in one
// place, no style attribute from own code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFiles, headTags } from './_frontendFiles.mjs';

const files = sourceFiles();
const html = files.find(([n]) => n === 'index.html')[1];
const own = files.filter(([n]) => n.startsWith('src/') && !n.startsWith('src/components/ui/'));

// Invariant: no HTML-string sinks, dynamic code, hash writes, parent scripting or cc localStorage keys in the UI source.
test('frontend uses no HTML-string sinks, eval, hash writes, window.parent or cc keys', () => {
  const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|setAttribute\(\s*['"]style|dangerouslySetInnerHTML|location\.hash\s*=|window\.parent|code-conductor:/;
  assert.ok(files.length > 10, 'scanned the UI sources');
  for (const [n, src] of files) assert.equal(banned.test(src), false, `${n}: ${src.match(banned)?.[0]}`);
});

// Invariant: every URL is relative (cc mounts the page under /plugins/code-hub/), except the two host URLs in index.html.
test('frontend uses no root-relative URLs', () => {
  const rootRel = /(?:src|href)\s*=\s*["']\/|['"`]\/api|fetch\(\s*['"`]\//g;
  const HOST = new Set(['src="/pluginBridge.js"', 'href="/pluginTheme.css"']);
  for (const [n, src] of files) {
    for (const m of src.matchAll(rootRel)) {
      const at = src.slice(m.index).match(/^(?:src|href)\s*=\s*"[^"]*"/)?.[0];
      assert.ok(n === 'index.html' && HOST.has(at), `${n}: ${at ?? m[0]}`);
    }
  }
  assert.match(html, /src="\/pluginBridge\.js"/);
  assert.match(html, /href="\/pluginTheme\.css"/);
});

// Invariant: the CSP forbids inline script, so the shell has none, and no inline style either.
test('index.html has no inline script or style', () => {
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'inline <script>');
  assert.equal(/<style[\s>]/.test(html), false, '<style>');
  assert.equal(/\sstyle\s*=/.test(html), false, 'style=');
});

// Invariant: <head> loads the bridge first and blocking, then the host theme, then theme-init.js, then the module entry.
test('index.html head order: bridge (blocking), theme, theme-init, entry', () => {
  const tags = headTags(html);
  const order = tags
    .filter((t) => t.tag === 'script' || (t.tag === 'link' && /rel="stylesheet"/.test(t.attrs)))
    .map((t) => t.attrs.match(/(?:src|href)="([^"]+)"/)[1]);
  assert.deepEqual(order, ['/pluginBridge.js', '/pluginTheme.css', 'theme-init.js', './src/main.tsx']);
  assert.equal(tags.findIndex((t) => t.tag === 'script'), tags.findIndex((t) => t.attrs.includes('/pluginBridge.js')), 'the bridge is the first script');
  assert.doesNotMatch(tags.find((t) => t.attrs.includes('/pluginBridge.js')).attrs, /\b(?:defer|async|type="module")\b/);
  assert.match(tags.find((t) => t.attrs.includes('main.tsx')).attrs, /type="module"/);
});

// Invariant: a link is built from data in exactly one place, ExternalLink, which allowlists its scheme.
test('href= appears in own code only in components/ExternalLink.tsx', () => {
  // An attribute or props key, not a member read such as `url.href`.
  const href = /(?<![.\w])href\s*[=:]/;
  const hits = files.filter(([n, src]) => n !== 'index.html' && href.test(src)).map(([n]) => n);
  assert.deepEqual(hits, ['src/components/ExternalLink.tsx']);
  assert.match(files.find(([n]) => n === 'src/components/ExternalLink.tsx')[1], /safeHref\(/);
});

// Invariant: own code sets no style attribute or style property, so nothing from content becomes live CSS
// under style-src 'unsafe-inline'.
test('own code sets no style attribute or property', () => {
  const style = /\bstyle\s*=|\.style\b|\bsetProperty\s*\(/;
  assert.ok(own.length > 10);
  for (const [n, src] of own) assert.equal(style.test(src), false, `${n}: ${src.match(style)?.[0]}`);
});
