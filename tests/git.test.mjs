import test from 'node:test';
import assert from 'node:assert/strict';
import { headSha, currentBranch, lastCommitAt } from '../src/git.js';
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

test('lastCommitAt returns an ISO-8601 date that advances on new commits', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'repo', { start: 'x' }, { git: true });

  const at1 = await lastCommitAt(dir);
  assert.match(at1, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(!Number.isNaN(Date.parse(at1)));
  gitCommit(dir, 'second');
  const at2 = await lastCommitAt(dir);
  assert.ok(Date.parse(at2) >= Date.parse(at1));
});

test('lastCommitAt returns null for a non-repo directory', async (t) => {
  const root = await mkRoot();
  t.after(() => rmRoot(root));
  const dir = await mkProject(root, 'plain', { start: 'x' });
  assert.equal(await lastCommitAt(dir), null);
});
