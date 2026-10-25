// A stand-in code-hub process for relay tests: in a "container" (the probe is
// forced), it runs src/hostRelay.js against the relay published under
// PROJECTS_ROOT, exposes one echo server in every scope named on the command
// line, prints `{"hostPorts":{<scope>:<port>,…}}` once all are bound, and stays
// alive until killed. RELAY_CLIENT_TIMINGS (JSON) shortens the session timings.
import net from 'node:net';
import * as hostRelay from '../../src/hostRelay.js';
import { _setHostPollMs } from '../../src/relayStore.js';
import { _setTimings } from '../../src/relaySession.js';
import { _setContainerProbe } from '../../src/net.js';

_setContainerProbe(() => true);
hostRelay._setLoopbackDialHost('127.0.0.1');
_setHostPollMs(50);
if (process.env.RELAY_CLIENT_TIMINGS) _setTimings(JSON.parse(process.env.RELAY_CLIENT_TIMINGS));

const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
await new Promise((r) => echo.listen(0, '127.0.0.1', r));
const port = echo.address().port;
let printed = false;
const handles = {};
const report = () => {
  const hostPorts = Object.fromEntries(Object.entries(handles).map(([scope, h]) => [scope, h.hostPort()]));
  if (printed || Object.values(hostPorts).some((p) => !p)) return;
  printed = true;
  process.stdout.write(`${JSON.stringify({ hostPorts })}\n`);
};
for (const scope of process.argv.slice(2)) handles[scope] = hostRelay.expose(port, scope, { host: '127.0.0.1', port }, report);
await hostRelay.init();
setInterval(() => {}, 1 << 30);
