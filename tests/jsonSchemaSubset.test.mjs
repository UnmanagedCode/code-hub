import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validate } from './jsonSchemaSubset.mjs';

// Invariant: the test-only copy enforces the same schema subset cc does, so a
// manifest it accepts is one cc loads and a drifted copy fails here.
test('checkSchema rejects what cc rejects and accepts what cc accepts', () => {
  assert.throws(() => checkSchema({ type: 'string', pattern: 'x' }), /pattern/);
  assert.throws(() => checkSchema({ oneOf: [] }), /oneOf/);
  assert.throws(() => checkSchema({ $ref: '#/x' }), /\$ref/);
  assert.throws(() => checkSchema({ type: 'object', properties: {} }), /additionalProperties/);
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, required: ['a'], properties: {} }), /not a property/);
  assert.throws(() => checkSchema({ anyOf: [] }), /non-empty/);
  assert.doesNotThrow(() => checkSchema({ description: 'anything' }));
  assert.doesNotThrow(() => checkSchema({ type: ['object', 'null'], additionalProperties: true }));
});

// Invariant: the copy's validate flags the same mismatches cc's runtime check does.
test('validate flags mismatches and accepts conforming values', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['a'],
    properties: { a: { type: 'integer' }, k: { enum: ['x'] }, c: { const: 1 }, n: { type: 'number' }, u: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  };
  assert.deepEqual(validate(schema, { a: 1, n: 2, u: null }), []);
  assert.match(validate(schema, { a: 'x' })[0], /expected integer/);
  assert.match(validate(schema, { a: 1, z: 1 })[0], /unexpected property 'z'/);
  assert.match(validate(schema, { a: 1, k: 'y' })[0], /not one of/);
  assert.match(validate(schema, { a: 1, c: 2 })[0], /expected const/);
  assert.match(validate(schema, {})[0], /missing required 'a'/);
  assert.match(validate(schema, { a: 1, u: 5 })[0], /no anyOf branch/);
});
