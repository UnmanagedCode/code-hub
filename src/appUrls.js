// The URLs an app's route is served at, primary first. While the app is
// mirrored onto the Docker host's loopback (loopbackMirror.js), the primary is
// that mirror — the address a browser on the host can open; otherwise it is
// `localhost` at the app's own port. Each LAN IP follows, at the app's own port.
export function appUrls({ port, routePath = '/', lanIps = [], hostLoopbackPort = null }) {
  const bases = [
    hostLoopbackPort ? `http://127.0.0.1:${hostLoopbackPort}` : `http://localhost:${port}`,
    ...lanIps.map((ip) => `http://${ip}:${port}`),
  ];
  return routePath === '/' ? bases : bases.map((b) => b + routePath);
}
