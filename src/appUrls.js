// The URLs an app's route is served at, primary first. While the app is
// mirrored onto the Docker host's loopback (loopbackMirror.js), the primary is
// that mirror — the address a browser on the host can open; else, while the app
// is reachable at the container's bridge address (bridgeForward.js), it is that
// address at the app's own port; otherwise it is `localhost` at the app's own
// port. Each LAN IP follows at the app's own port, less the bridge address when
// that is already the primary.
export function appUrls({ port, routePath = '/', lanIps = [], hostLoopbackPort = null, bridgeHost = null }) {
  const bridgePrimary = !hostLoopbackPort && !!bridgeHost;
  const primary = hostLoopbackPort ? `http://127.0.0.1:${hostLoopbackPort}`
    : bridgePrimary ? `http://${bridgeHost}:${port}`
      : `http://localhost:${port}`;
  const bases = [
    primary,
    ...lanIps.filter((ip) => !(bridgePrimary && ip === bridgeHost)).map((ip) => `http://${ip}:${port}`),
  ];
  return routePath === '/' ? bases : bases.map((b) => b + routePath);
}
