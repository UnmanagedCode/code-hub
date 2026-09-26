import express from 'express';
import * as appManager from './appManager.js';
import * as mcp from './mcp.js';

// Thin HTTP layer over appManager. Error convention matches code-conductor:
// a thrown error with an optional `statusCode` becomes `{ error }`.
export function buildRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  };

  r.get('/health', wrap(() => ({ ok: true })));

  r.get('/apps', wrap(() => appManager.list()));
  r.post('/apps/:id/start', wrap((req) => appManager.start(req.params.id)));
  r.post('/apps/:id/stop', wrap((req) => appManager.stop(req.params.id)));
  r.post('/apps/:id/restart', wrap((req) => appManager.restart(req.params.id)));
  r.post('/apps/:id/share', wrap((req) => appManager.share(req.params.id, { mode: req.body?.mode, auth: req.body?.auth, tls: req.body?.tls })));
  r.patch('/apps/:id/share/credentials', wrap((req) => appManager.updateShareCredentials(req.params.id, req.body)));
  r.patch('/apps/:id/share/auth', wrap((req) => appManager.setShareAuth(req.params.id, req.body?.enabled)));
  r.get('/apps/:id/share/defaults', wrap((req) => appManager.getShareDefaults(req.params.id)));
  r.put('/apps/:id/share/defaults', wrap((req) => appManager.setShareDefaults(req.params.id, req.body)));
  r.delete('/apps/:id/share/defaults', wrap((req) => appManager.clearShareDefaults(req.params.id)));
  r.delete('/apps/:id/share', wrap((req) => appManager.unshare(req.params.id)));

  // MCP tool-call bridge for code-conductor: unlike wrap()'s statusCode
  // convention, tool-level outcomes (unknown tool, bad args, already-running)
  // are normal MCP results, not transport failures -- see docs/protocol.md.
  r.post('/mcp', async (req, res) => {
    const { status, body } = await mcp.handle(req.body);
    res.status(status).json(body);
  });

  // Malformed JSON body -> 400 {error}, not Express's default HTML page.
  r.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid request body' });
    }
    next(err);
  });

  return r;
}
