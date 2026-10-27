// A stand-in code-hub: starts one app through the real runner, prints one JSON
// line `{ status, pid, pgid, port }`, then stays alive until killed — so a test
// can SIGKILL "the hub that launched the app" and inspect what the app does next.
// Usage: node launch-app.mjs <id> <dir> <start> <port>   (PROJECTS_ROOT from env)
import * as runner from '../../src/runner.js';

const [id, dir, start, port] = process.argv.slice(2);
const rec = await runner.start({ id, path: dir, manifest: { start, healthPath: null, readyWhen: null } }, Number(port));
const status = await rec.settled;
console.log(JSON.stringify({ status, pid: rec.pid, pgid: rec.pgid, port: rec.port }));
setInterval(() => {}, 1e9);
