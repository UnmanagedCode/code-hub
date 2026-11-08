import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './jsonSchemaSubset.mjs';

const manifest = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'conductor.plugin.json'), 'utf8'));

export const manifestOutputSchema = (tool) => manifest.mcp.tools.find((t) => t.name === tool)?.outputSchema;

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;
const subset = (keys, allowed) => keys.every((k) => allowed.includes(k));

// POST one MCP envelope and enforce cc's reply contract on the answer: a json
// success is exactly {structured} and validates against the tool's declared
// outputSchema; a text success is {text, meta?}; a refusal is {error, code, details?}.
// A non-200 is a transport failure and is returned unchecked.
export async function callTool(base, tool, args, { format, raw } = {}) {
  const envelope = { tool, arguments: args, caller: { sessionId: 's1', project: 'p1' }, ...(format !== undefined ? { format } : {}), ...raw };
  const r = await fetch(base + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
  const body = await r.json();
  if (r.status !== 200) return { status: r.status, body };
  const keys = Object.keys(body);
  if ('error' in body) {
    assert.ok(subset(keys, ['error', 'code', 'details']), `refusal keys ${keys}`);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
    assert.match(body.code, CODE_RE);
    if ('details' in body) assert.ok(body.details && typeof body.details === 'object' && !Array.isArray(body.details));
  } else if (format === 'json') {
    assert.deepEqual(keys, ['structured']);
    const schema = manifestOutputSchema(tool);
    assert.ok(schema, `${tool} declares no outputSchema`);
    assert.deepEqual(validate(schema, body.structured), []);
  } else {
    assert.ok(subset(keys, ['text', 'meta']) && keys.includes('text'), `text keys ${keys}`);
    assert.equal(typeof body.text, 'string');
  }
  return { status: r.status, body };
}
