// A stand-in code-hub for relay tests: opens and attaches a forward through
// src/hostRelay.js (CODEHUB_RELAY_URL/SECRET from the environment), prints
// `{"port":…,"id":…}` and stays alive until killed.
import net from 'node:net';
import { openForward } from '../../src/hostRelay.js';

const target = net.createServer((s) => s.pipe(s));
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const handle = await openForward({});
handle.attach({ host: '127.0.0.1', port: target.address().port });
process.stdout.write(`${JSON.stringify({ port: handle.port, id: handle.id })}\n`);
setInterval(() => {}, 1 << 30);
