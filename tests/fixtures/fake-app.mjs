// A stand-in for a servable app. Binds $PORT, prints a readiness marker, and
// stays up until signalled (SIGTERM/SIGKILL) — exactly the "single blocking
// start command" contract code-hub expects.
//
// FAKE_APP_MODE:
//   (default) → bind $PORT, print "listening on <port>", serve 200 OK, block.
//   crash     → exit(1) immediately without binding (simulates a broken app).
import http from 'node:http';

if (process.env.FAKE_APP_MODE === 'crash') {
  console.error('boom: could not start');
  process.exit(1);
}

const port = Number(process.env.PORT);
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
server.listen(port, '127.0.0.1', () => {
  console.log(`listening on ${port}`);
});

// Keep the process alive and exit cleanly on SIGTERM so process-group kill is
// observable in tests.
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
