import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/projects.js';

test('accepts a minimal manifest with defaults', () => {
  const m = parseManifest('{"start":"npm start"}');
  assert.equal(m.start, 'npm start');
  assert.equal(m.name, null);
  assert.equal(m.healthPath, null);
  assert.equal(m.readyWhen, null);
});

test('keeps optional string fields', () => {
  const m = parseManifest('{"start":"x","name":"My App","healthPath":"/health","readyWhen":"up"}');
  assert.equal(m.name, 'My App');
  assert.equal(m.healthPath, '/health');
  assert.equal(m.readyWhen, 'up');
});

test('rejects missing / empty start', () => {
  assert.throws(() => parseManifest('{}'), /"start" is required/);
  assert.throws(() => parseManifest('{"start":"  "}'), /"start" is required/);
  assert.throws(() => parseManifest('{"start":123}'), /"start" is required/);
});

test('rejects wrong-typed optional field', () => {
  assert.throws(() => parseManifest('{"start":"x","name":5}'), /"name" must be a string/);
});

test('rejects malformed JSON and non-objects', () => {
  assert.throws(() => parseManifest('not json'), /invalid JSON/);
  assert.throws(() => parseManifest('[1,2]'), /must be a JSON object/);
});
