import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findPython, requirePython, REPO_ROOT } from './helpers.mjs';

// Invariant: a run without CODEHUB_SKIP_PYTHON=1 can never pass the relay suite
// without a usable interpreter — this fails even if every other relay test were skipped.
test('relay suite has a Python interpreter', (t) => {
  if (!requirePython(t)) return;
  assert.ok(findPython().ok);
});

// Invariant: the relay's Python unit tests (tests/python, P1–P8) pass under the interpreter npm test uses.
test('relay Python unit tests pass', (t) => {
  if (!requirePython(t)) return;
  const py = findPython();
  const r = spawnSync(py.cmd, [...py.args, '-m', 'unittest', 'discover', '-s', path.join(REPO_ROOT, 'tests', 'python'), '-v'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `python -m unittest failed:\n${r.stdout}\n${r.stderr}`);
});
