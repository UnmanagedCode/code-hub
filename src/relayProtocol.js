import { readFileSync } from 'node:fs';

// The host-relay wire protocol, read from its single source: relay/protocol.json,
// which relay/relay.py reads too. Nothing on the code-hub side restates a value
// from it.
export const PROTOCOL = Object.freeze(JSON.parse(readFileSync(new URL('../relay/protocol.json', import.meta.url), 'utf8')));
