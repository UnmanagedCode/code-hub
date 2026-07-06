import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/projects.js';

test('accepts a minimal manifest with defaults', () => {
  const m = parseManifest('{"start":"npm start"}');
  assert.equal(m.start, 'npm start');
  assert.equal(m.name, null);
  assert.equal(m.healthPath, null);
  assert.equal(m.readyWhen, null);
  assert.equal(m.routes, null);
});

test('accepts and normalizes a routes array', () => {
  const m = parseManifest('{"start":"x","routes":[{"name":"Main","path":"/"},{"name":"Editor","path":"/edit.html","extra":1}]}');
  assert.deepEqual(m.routes, [
    { name: 'Main', path: '/' },
    { name: 'Editor', path: '/edit.html' }, // unknown per-route keys dropped
  ]);
});

test('rejects a bad routes field, naming the file', () => {
  const F = 'proj/.hub.json';
  assert.throws(() => parseManifest('{"start":"x","routes":[]}', F), /proj\/\.hub\.json: "routes" must be a non-empty array/);
  assert.throws(() => parseManifest('{"start":"x","routes":"/"}', F), /"routes" must be a non-empty array/);
  assert.throws(() => parseManifest('{"start":"x","routes":["/"]}', F), /routes\[0\] must be an object/);
  assert.throws(() => parseManifest('{"start":"x","routes":[{"path":"/"}]}', F), /routes\[0\]\.name is required/);
  assert.throws(() => parseManifest('{"start":"x","routes":[{"name":"","path":"/"}]}', F), /routes\[0\]\.name is required/);
  assert.throws(() => parseManifest('{"start":"x","routes":[{"name":"A"}]}', F), /routes\[0\]\.path is required and must start with "\/"/);
  assert.throws(() => parseManifest('{"start":"x","routes":[{"name":"A","path":"edit.html"}]}', F), /routes\[0\]\.path is required and must start with "\/"/);
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
