#!/usr/bin/env node
// Stand-in for the tailscale binary. `status --json` prints a canned status
// payload (so availability detection and MagicDNS-name derivation pass);
// `funnel ... <target>` prints the real banner shape then blocks until killed,
// mirroring the foreground funnel code-hub actually spawns.
//
// FAKE_TAILSCALE_MODE:
//   (unset)    running node with a MagicDNS name; funnel comes up
//   logged-out BackendState NeedsLogin + no DNSName → available() false
//   denied     funnel is refused by the tailnet: stderr + exit 1, NO URL
const args = process.argv.slice(2);
const mode = process.env.FAKE_TAILSCALE_MODE || '';

// Trailing dot included on purpose — the real CLI reports the name
// fully-qualified, and stripping it is what code-hub's derivation must do.
const DNS_NAME = 'fake-node.example-tailnet.ts.net.';

if (args[0] === 'status') {
  const payload = mode === 'logged-out'
    ? { BackendState: 'NeedsLogin', Self: { DNSName: '' } }
    : { BackendState: 'Running', Self: { DNSName: DNS_NAME } };
  console.log(JSON.stringify(payload));
  process.exit(0);
}

if (args[0] === 'funnel') {
  if (mode === 'denied') {
    process.stderr.write('Funnel is not enabled on your tailnet.\n');
    process.exit(1);
  }
  const target = args[args.length - 1];
  process.stdout.write('Available on the internet:\n\n');
  process.stdout.write(`https://${DNS_NAME.replace(/\.$/, '')}/\n`);
  process.stdout.write(`|-- proxy ${target}\n\n`);
  process.stdout.write('Press Ctrl+C to exit.\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1 << 30); // block
} else {
  process.exit(2);
}
