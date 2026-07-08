import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

async function readJson(name) {
  return JSON.parse(await fs.readFile(path.join(ROOT, name), 'utf8'));
}

// Every property of a shallow JSON-Schema must be a plain string/number/
// integer/boolean type — no $ref/oneOf/anyOf/nested objects, matching the
// pluginApi v1 constraint that conductor.plugin.json manifests are validated
// against.
const SHALLOW_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
function assertShallowSchema(schema, label) {
  assert.equal(schema.type, 'object', `${label}.type must be "object"`);
  assert.ok(!('$ref' in schema), `${label} must not use $ref`);
  assert.ok(!('oneOf' in schema) && !('anyOf' in schema), `${label} must not use oneOf/anyOf`);
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    assert.ok(SHALLOW_TYPES.has(prop.type), `${label}.properties.${key}.type must be a shallow scalar type`);
  }
}

test('conductor.plugin.json: version matches package.json', async () => {
  const pkg = await readJson('package.json');
  const manifest = await readJson('conductor.plugin.json');
  assert.equal(manifest.version, pkg.version);
});

test('conductor.plugin.json: required top-level fields', async () => {
  const manifest = await readJson('conductor.plugin.json');
  assert.equal(manifest.id, 'code-hub');
  assert.equal(manifest.name, 'Code Hub');
  assert.equal(manifest.pluginApi, 1);
  assert.equal(manifest.backend.start, 'npm start');
  assert.equal(manifest.backend.healthPath, '/api/health');
  assert.equal(manifest.frontend.path, '/');
  assert.equal(manifest.mcp.endpoint, '/api/mcp');
  assert.equal(manifest.mcp.scope, 'project');
});

test('conductor.plugin.json: mcp.tools declare the 3 expected tools with shallow schemas', async () => {
  const manifest = await readJson('conductor.plugin.json');
  const names = manifest.mcp.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['list_apps', 'start_app', 'stop_app']);
  for (const tool of manifest.mcp.tools) {
    assert.ok(tool.description, `${tool.name} needs a description`);
    assertShallowSchema(tool.inputSchema, `${tool.name}.inputSchema`);
  }
  const startTool = manifest.mcp.tools.find((t) => t.name === 'start_app');
  assert.deepEqual(startTool.inputSchema.required, ['id']);
  const stopTool = manifest.mcp.tools.find((t) => t.name === 'stop_app');
  assert.deepEqual(stopTool.inputSchema.required, ['id']);
});
