import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { childEnv } from '../src/childEnv.js';
import { REPO_ROOT } from './helpers.mjs';

// Invariant: the child environment drops the relay variables under any letter case (Windows env names are case-insensitive) and keeps everything else.
test('childEnv strips the relay variables case-insensitively', (t) => {
  const names = ['CODEHUB_RELAY_SECRET', 'codehub_relay_secret', 'Codehub_Relay_Url', 'CODEHUB_RELAY_URL'];
  for (const n of names) process.env[n] = 'x';
  process.env.CODEHUB_RELAY_SECRETS_ARE_FINE = 'kept';
  t.after(() => { for (const n of [...names, 'CODEHUB_RELAY_SECRETS_ARE_FINE']) delete process.env[n]; });
  const env = childEnv({ PORT: '1234' });
  for (const n of names) assert.equal(n in env, false, n);
  assert.equal(env.CODEHUB_RELAY_SECRETS_ARE_FINE, 'kept');
  assert.equal(env.PORT, '1234');
  assert.equal(env.PATH, process.env.PATH);
});

const CHILD_APIS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

// End index (exclusive) of the string/template literal starting at src[i].
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j += 1; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') { j = skipBalanced(src, j + 1, '{', '}') - 1; continue; }
    if (src[j] === q) return j + 1;
  }
  return src.length;
}

// End index (exclusive) of the bracketed span opening at src[i], skipping
// strings, templates and comments.
function skipBalanced(src, i, open, close) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\'' || c === '"' || c === '`') { j = skipString(src, j) - 1; continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) return src.length; continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 1; continue; }
    if (c === open) depth += 1;
    if (c === close && --depth === 0) return j + 1;
  }
  return src.length;
}

// Every child-process call in `src`, by what the file imports from
// node:child_process: its named imports called bare, and member calls on its
// default/namespace import. A regex's .exec() is neither. Returns
// [{ call, args }], `args` being the call's own balanced argument list.
function childProcessCalls(src) {
  const bare = new Set();
  const objects = new Set();
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+['"](?:node:)?child_process['"]/g)) {
    const clause = m[1];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (CHILD_APIS.includes(name)) bare.add(alias ?? name);
      }
    }
    const def = /^\s*(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/.exec(clause.replace(/\{[^}]*\}/, '').replace(/^,|,$/g, ''));
    if (def) objects.add(def[1]);
  }
  const calls = [];
  for (const m of src.matchAll(/(?<![\w$])(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, obj, name] = m;
    const isCall = obj ? objects.has(obj) && CHILD_APIS.includes(name) : bare.has(name) && src[m.index - 1] !== '.';
    if (!isCall) continue;
    const open = m.index + m[0].length - 1;
    calls.push({ call: m[0], args: src.slice(open, skipBalanced(src, open, '(', ')')) });
  }
  return calls;
}

const missingChildEnv = (src) => childProcessCalls(src).filter((c) => !/\benv:\s*childEnv\(/.test(c.args));

// Invariant: the scan below sees every child-process API by import, ignores a regex's .exec(), and judges env: childEnv( only inside the call's own arguments.
test('the child-process scan flags a planted call and ignores lookalikes', () => {
  const planted = [
    "import cp from 'node:child_process';",
    "import { spawn as run, fork } from 'node:child_process';",
    "cp.execSync('x', {});",
    "run('y', ['a'], { cwd: '/' });",
    "fork('z.js', [], { env: childEnv() });",
    "cp.execFile('git', [`a${f(')')}`], { env: childEnv() }, (e) => {});",
    "/re/.exec('s'); m.exec(s); exec(s);",
    "spawnLater(); const opts = { env: childEnv() };",
  ].join('\n');
  assert.deepEqual(childProcessCalls(planted).map((c) => c.call.replace(/\s/g, '')), ['cp.execSync(', 'run(', 'fork(', 'cp.execFile(']);
  assert.deepEqual(missingChildEnv(planted).map((c) => c.call.replace(/\s/g, '')), ['cp.execSync(', 'run(']);
});

// Invariant: every child code-hub spawns or execs gets the sanitised environment — no child-process call in src/ falls back to inheriting process.env.
test('every child-process call in src/ passes env: childEnv(…) in its own arguments', () => {
  const dir = path.join(REPO_ROOT, 'src');
  let sites = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    sites += childProcessCalls(src).length;
    assert.deepEqual(missingChildEnv(src).map((c) => c.call), [], file);
  }
  assert.ok(sites >= 7, `found the call sites (${sites})`);
});
