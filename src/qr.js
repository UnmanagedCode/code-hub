import QRCode from 'qrcode';

// Render a URL as a standalone inline SVG string (no external assets), sized
// to fit a phone card. Dark-theme friendly: dark modules on a light quiet
// zone so camera apps scan reliably.
export function qrSvg(text) {
  // QRCode.toString returns a Promise — callers await it.
  return QRCode.toString(text, {
    type: 'svg',
    margin: 2,
    width: 240,
    color: { dark: '#0f1117', light: '#ffffff' },
  });
}
