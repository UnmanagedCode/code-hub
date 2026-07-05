import express from 'express';
import * as appManager from './appManager.js';

// Thin HTTP layer over appManager. Error convention matches code-conductor:
// a thrown error with an optional `statusCode` becomes `{ error }`.
export function buildRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  };

  r.get('/apps', wrap(() => appManager.list()));
  r.post('/apps/:id/start', wrap((req) => appManager.start(req.params.id)));
  r.post('/apps/:id/stop', wrap((req) => appManager.stop(req.params.id)));
  r.post('/apps/:id/restart', wrap((req) => appManager.restart(req.params.id)));
  r.post('/apps/:id/share', wrap((req) => appManager.share(req.params.id)));
  r.delete('/apps/:id/share', wrap((req) => appManager.unshare(req.params.id)));

  return r;
}
