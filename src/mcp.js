import * as appManager from './appManager.js';
import { httpError } from './httpError.js';
import * as text from './mcpText.js';

function requireId(args) {
  if (!args || typeof args.id !== 'string' || args.id.length === 0) {
    throw httpError(400, 'ARGS_INVALID', 'id is required and must be a non-empty string');
  }
  return args.id;
}

// The listing REST serves, plus what only the MCP view carries: each app's log
// file and, for a crashed app, its reason line alone and the whole retained
// output (REST's `error` embeds a short output tail instead).
async function listApps() {
  const data = await appManager.list();
  return {
    ...data,
    apps: data.apps.map((app) => {
      const d = appManager.runDetail(app.id);
      const crashed = app.status === 'crashed';
      return {
        ...app,
        logFile: d.logFile,
        error: crashed ? d.reason : app.error,
        output: crashed ? d.output : null,
        outputTruncated: crashed ? d.outputTruncated : null,
      };
    }),
  };
}

const tools = Object.assign(Object.create(null), {
  list_apps: { run: listApps, text: text.listApps },
  start_app: { run: (a) => appManager.start(requireId(a)), text: text.startApp },
  stop_app: { run: (a) => appManager.stop(requireId(a)), text: text.stopApp },
  register_app: { run: (a) => appManager.registerApp(a), text: text.registerApp },
  unregister_app: { run: (a) => appManager.unregisterApp(requireId(a)), text: text.unregisterApp },
});

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

// Only errors tagged with httpError carry a trusted code; a Node errno
// (`ENOENT`, ...) on an unexpected throw is never forwarded.
function refusal(e) {
  if (e.statusCode && typeof e.code === 'string' && CODE_RE.test(e.code)) {
    return { error: e.message, code: e.code, ...(e.details && { details: e.details }) };
  }
  console.error(`[mcp] unexpected tool failure: ${e.stack || e.message}`);
  return { error: e.message, code: 'INTERNAL' };
}

// Envelope-level problems (missing `tool`, bad `format`) -> 400. Everything
// else -> 200: unknown tool, bad arguments and tool-level failures are normal
// MCP outcomes for the calling LLM, not transport failures. A missing `format`
// is answered as text.
export async function handle(body) {
  const { tool, arguments: args, format = 'text' } = body || {};
  if (typeof tool !== 'string' || tool.length === 0) {
    return { status: 400, body: { error: 'tool is required and must be a non-empty string', code: 'REQUEST_INVALID' } };
  }
  if (format !== 'json' && format !== 'text') {
    return { status: 400, body: { error: 'format must be "json" or "text"', code: 'FORMAT_INVALID', details: { format } } };
  }
  const def = tools[tool];
  if (!def) return { status: 200, body: { error: `unknown tool: ${tool}`, code: 'TOOL_UNKNOWN' } };
  try {
    const data = await def.run(args ?? {});
    return { status: 200, body: format === 'json' ? { structured: data } : { text: def.text(data) } };
  } catch (e) {
    return { status: 200, body: refusal(e) };
  }
}
