import test from 'node:test';
import assert from 'node:assert/strict';
import { headSha, currentBranch } from '../src/git.js';
import { mkRoot, rmRoot, mkProject, gitCommit } from './helpers.mjs';

test('headSha reads HEAD and reflects new commits', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'repo', { start: 'x' }, { git: true });

  const sha1 = await headSha(dir);
  assert.match(sha1, /^[0-9a-f]{40}$/);
  const sha2 = gitCommit(dir);
  assert.equal(await headSha(dir), sha2);
  assert.notEqual(sha1, sha2);
  assert.ok(await currentBranch(dir)); // some default branch name
});

test('headSha returns null for a non-repo directory', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'plain', { start: 'x' });
  assert.equal(await headSha(dir), null);
});
