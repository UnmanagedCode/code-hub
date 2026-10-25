// A fake host relay, in-process, for code-hub's side of the protocol: it
// publishes itself in the rendezvous dir under `root` and speaks the protocol
// with its own crypto (tests/helpers.mjs), misbehaving on request:
//   impostor      the control welcome carries a wrong MAC
//   impostorData  a data welcome carries a wrong MAC
//   silent        never pings and never answers a ping
//   autoStatus    answer every ports frame with a status binding each pair (default on)
//   dataDelayMs   hold each data handshake this long before the welcome
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RELAY_PROTOCOL as P, protoMac, frameStream, relaySecret } from '../helpers.mjs';

const send = (socket, frame) => { if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`); };

export async function startFakeRelay({ root, impostor = false, impostorData = false, silent = false, autoStatus = true, dataDelayMs = 0, version = P.protocolVersion } = {}) {
  const secret = await relaySecret(root);
  const fake = {
    accepted: [], // accept times
    controls: [], // { socket, session, ports: [frames], closed }
    dataAuths: [], // { conn, session }
    dataWelcomed: 0,
    preAuth: 0,
    maxPreAuth: 0,
    sockets: new Set(),
  };
  const server = net.createServer(async (socket) => {
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    fake.accepted.push(Date.now());
    fake.preAuth += 1;
    fake.maxPreAuth = Math.max(fake.maxPreAuth, fake.preAuth);
    let counted = true;
    const done = () => { if (counted) { counted = false; fake.preAuth -= 1; } };
    socket.on('close', done);
    const frames = frameStream(socket);
    const nonceRelay = crypto.randomBytes(P.nonceBytes).toString('base64url');
    send(socket, { t: P.frames.hello, v: version, nonce: nonceRelay });
    let auth;
    try { auth = await frames.next(5000); } catch { socket.destroy(); return; }
    if (!auth) return;
    const session = auth.session ?? '';
    const conn = auth.conn ?? '';
    if (auth.mac !== protoMac(secret, P.macLabels.hub, auth.role, nonceRelay, auth.nonce, session, conn)) {
      send(socket, { t: P.frames.error, code: P.errorCodes.authFailed, message: 'wrong MAC' });
      socket.end();
      return;
    }
    const proof = protoMac(secret, P.macLabels.relay, auth.role, nonceRelay, auth.nonce, session, conn);
    if (auth.role === P.roles.data) {
      fake.dataAuths.push({ conn, session });
      if (dataDelayMs) await new Promise((r) => setTimeout(r, dataDelayMs));
      done();
      send(socket, { t: P.frames.welcome, mac: impostorData ? 'f'.repeat(64) : proof });
      fake.dataWelcomed += 1;
      return;
    }
    done();
    const id = crypto.randomBytes(12).toString('base64url');
    const c = { socket, session: id, ports: [], received: [], closed: false };
    socket.on('close', () => { c.closed = true; });
    fake.controls.push(c);
    send(socket, { t: P.frames.welcome, mac: impostor ? 'f'.repeat(64) : proof, session: id, addresses: ['127.0.0.1'] });
    for (;;) {
      let f;
      try { f = await frames.next(60000); } catch { return; }
      if (!f) return;
      c.received.push(f);
      if (f.t === P.frames.ping && !silent) send(socket, { t: P.frames.pong });
      if (f.t === P.frames.ports) {
        c.ports.push(f.ports);
        if (autoStatus) {
          send(socket, {
            t: P.frames.status, addresses: ['127.0.0.1'],
            ports: f.ports.map((e) => ({ ...e, hostPort: e.port, fallback: false })),
          });
        }
      }
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.port = server.address().port;
  fake.hostFile = path.join(root, '.code-hub', P.rendezvous.dir, P.rendezvous.relayFile);
  fake.publish = (over = {}) => fs.writeFile(fake.hostFile, JSON.stringify({ protocolVersion: P.protocolVersion, listen: `127.0.0.1:${fake.port}`, pid: process.pid, ...over }));
  fake.control = () => fake.controls.at(-1);
  fake.send = (frame) => send(fake.control().socket, frame);
  fake.close = () => new Promise((r) => { for (const s of fake.sockets) s.destroy(); server.close(r); });
  await fake.publish();
  return fake;
}
