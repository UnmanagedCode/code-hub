// Pins the package split the install hook depends on: the backend's runtime
// deps only in `dependencies`, the UI built from devDependencies by `prepare`,
// and the build output and lockfile left untracked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());

// Invariant: the runtime needs only the backend's two packages; nothing of the UI ships as a runtime dep.
test('dependencies are exactly the backend runtime', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'qrcode']);
});

// Invariant: the build, UI and test packages are devDependencies; no toast library and no bundled fonts.
test('devDependencies carry the build, UI and test packages, without sonner or fontsource', () => {
  const dev = Object.keys(pkg.devDependencies);
  for (const name of ['vite', '@vitejs/plugin-react', '@tailwindcss/vite', 'tailwindcss', 'tw-animate-css', 'typescript',
    'react', 'react-dom', '@types/react', '@types/react-dom', 'radix-ui', 'class-variance-authority', 'clsx', 'tailwind-merge',
    'lucide-react', 'vitest', 'happy-dom', '@testing-library/react', '@testing-library/user-event']) {
    assert.ok(dev.includes(name), `missing devDependency ${name}`);
  }
  assert.equal(dev.includes('sonner'), false, 'sonner');
  assert.deepEqual(dev.filter((d) => d.startsWith('@fontsource')), []);
});

// Invariant: `npm install` builds the UI (prepare); `npm test` rebuilds it first, so tests/dist.test.mjs measures the
// current source rather than whatever frontend/dist last held, then runs the node suite, the typecheck and Vitest.
test('scripts: prepare builds, test rebuilds then chains all three suites', () => {
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(pkg.scripts.prepare, 'vite build --config frontend/vite.config.ts');
  assert.equal(pkg.scripts.dev, 'vite --config frontend/vite.config.ts');
  assert.equal(pkg.scripts.typecheck, 'tsc -p frontend');
  assert.equal(pkg.scripts['test:web'], 'vitest run --config frontend/vitest.config.ts');
  assert.equal(pkg.scripts.test, 'npm run prepare && NODE_OPTIONS=--max-old-space-size=512 node tests/run.mjs && npm run typecheck && npm run test:web');
});

// Invariant: the Node floor Vite 8 needs is recorded.
test('engines.node is the Vite 8 floor', () => {
  assert.equal(pkg.engines.node, '>=22.12.0');
});

// Invariant: nothing the hook writes is tracked, so Update's `git pull --ff-only` never collides with it.
test('.gitignore covers node_modules, frontend/dist/ and package-lock.json', () => {
  for (const p of ['node_modules', 'frontend/dist/', 'package-lock.json']) assert.ok(ignore.includes(p), p);
});
