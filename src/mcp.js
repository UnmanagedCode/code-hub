import * as appManager from './appManager.js';

function requireId(args) {
  if (!args || typeof args.id !== 'string' || args.id.length === 0) {
    throw new Error('id is required and must be a non-empty string');
  }
  return args.id;
}

const handlers = {
  list_apps: () => appManager.list(),
  start_app: (args) => appManager.start(requireId(args)),
  stop_app: (args) => appManager.stop(requireId(args)),
};

// Envelope-level problems (missing/invalid `tool`) -> 400.
// Everything else -> 200, body {result} or {error} -- unknown tool name,
// bad arguments, and tool-level failures (already-running, not-found) are
// normal MCP outcomes for the calling LLM, not transport failures.
export async function handle(body) {
  const { tool, arguments: args } = body || {};
  if (typeof tool !== 'string' || tool.length === 0) {
    return { status: 400, body: { error: 'tool is required and must be a non-empty string' } };
  }
  const fn = handlers[tool];
  if (!fn) return { status: 200, body: { error: `unknown tool: ${tool}` } };
  try {
    return { status: 200, body: { result: await fn(args ?? {}) } };
  } catch (e) {
    return { status: 200, body: { error: e.message } };
  }
}
