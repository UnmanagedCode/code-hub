import crypto from 'node:crypto';

// Generate a self-signed X.509 certificate with node:crypto only — no openssl
// shell-out (not installed on the target device) and no dependency (keeps deps
// at express+qrcode, per authproxy.js's note). Used to wrap LAN shares in TLS;
// the cert is generated fresh per share and held in memory only (never written
// to disk). Being self-signed, browsers show a one-time "not private" warning —
// this is documented as a known limitation for LAN HTTPS.
//
// Certs are built by hand-encoding ASN.1 DER: node exposes key generation and
// signing but no certificate builder, so we assemble the TBSCertificate
// ourselves, sign it, and wrap it into the Certificate SEQUENCE.

// --- Minimal DER encoders --------------------------------------------------

// Length octets: short form (<128) or long form (0x80|n followed by n bytes).
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) { bytes.unshift(x & 0xff); x >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), derLen(value.length), value]);
}

const SEQUENCE = (...parts) => tlv(0x30, Buffer.concat(parts));
const SET = (...parts) => tlv(0x31, Buffer.concat(parts));
const NULL = tlv(0x05, Buffer.alloc(0));
const UTF8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));

// INTEGER: prepend 0x00 when the high bit is set so it stays positive.
function INTEGER(buf) {
  if (buf.length && buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}
const smallInt = (n) => tlv(0x02, Buffer.from([n]));

// OBJECT IDENTIFIER: first two arcs pack into one byte, the rest base-128.
function OID(dotted) {
  const arcs = dotted.split('.').map(Number);
  const bytes = [40 * arcs[0] + arcs[1]];
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i];
    const chunk = [v & 0x7f];
    v >>>= 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

// UTCTime YYMMDDHHMMSSZ (valid for years 1950-2049 — fine for short-lived certs).
function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// subjectAltName GeneralNames: dNSName [2] (IA5String) and iPAddress [7] (octets).
function subjectAltName(ipAddresses, dnsNames) {
  const names = [];
  for (const d of dnsNames) names.push(tlv(0x82, Buffer.from(d, 'ascii')));
  for (const ip of ipAddresses) {
    const octets = ip.split('.').map(Number);
    names.push(tlv(0x87, Buffer.from(octets)));
  }
  const extnValue = tlv(0x04, SEQUENCE(...names)); // OCTET STRING wrapping the GeneralNames
  return SEQUENCE(OID('2.5.29.17'), extnValue);
}

const RSA_SHA256 = () => SEQUENCE(OID('1.2.840.113549.1.1.11'), NULL);

// --- Public API ------------------------------------------------------------

// Returns { key, cert } as PEM strings. `ipAddresses`/`dnsNames` populate the
// SAN so the cert at least matches the host (browsers still warn: self-signed).
export function generateSelfSigned({ ipAddresses = [], dnsNames = [], validityDays = 825 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const name = SEQUENCE(SET(SEQUENCE(OID('2.5.4.3'), UTF8String('code-hub LAN'))));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000); // 1h skew for clock drift
  const notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);
  const validity = SEQUENCE(utcTime(notBefore), utcTime(notAfter));
  const extensions = tlv(0xa3, SEQUENCE(subjectAltName(ipAddresses, dnsNames))); // [3] EXPLICIT

  const tbsCertificate = SEQUENCE(
    tlv(0xa0, smallInt(2)),          // [0] version, v3 (== 2)
    INTEGER(Buffer.from([0x01])),    // serialNumber
    RSA_SHA256(),                    // signature algorithm
    name,                            // issuer
    validity,
    name,                            // subject (== issuer: self-signed)
    spki,                            // subjectPublicKeyInfo
    extensions,
  );

  const signer = crypto.createSign('sha256');
  signer.update(tbsCertificate);
  signer.end();
  const signature = signer.sign(privateKey);

  const certDer = SEQUENCE(
    tbsCertificate,
    RSA_SHA256(),
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])), // BIT STRING (0 unused bits)
  );

  const cert = pem('CERTIFICATE', certDer);
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { key, cert };
}

function pem(label, der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
