// Decode an Orca pairing code (orca://pair?code=...) into .pairing.json using Orca's own decoder.
// usage: ELECTRON_RUN_AS_NODE=1 Orca pair.js <outFile>   (pairing code on stdin)
'use strict';
const fs = require('fs'), path = require('path');
const OUT = process.env.ORCA_OUT_DIR || path.join(process.env.ORCA_APP || '/Applications/Orca.app', 'Contents/Resources/app.asar.unpacked/out');
const { decodePairingOffer, parsePairingCode } = require(path.join(OUT, 'shared/pairing'));
const out = process.argv[2]; const input = fs.readFileSync(0, 'utf8').trim();
let offer;
try { offer = parsePairingCode ? parsePairingCode(input) : null; } catch { offer = null; }
if (!offer) offer = decodePairingOffer(input.startsWith('orca://') ? input : 'orca://pair?code=' + input);
if (!offer || !offer.deviceToken || !offer.publicKeyB64) { console.error('pairing code decoded but has no deviceToken/publicKeyB64; unsupported Orca version?'); process.exit(2); }
// The listener runs on the same Mac as Orca, so talk to it over loopback.
if (offer.endpoint && process.env.ORCA_NOTIFY_KEEP_ENDPOINT !== '1') {
  try { const u = new URL(offer.endpoint); u.hostname = '127.0.0.1'; offer.endpoint = u.toString().replace(/\/$/, ''); } catch {}
}
fs.writeFileSync(out, JSON.stringify(offer), { mode: 0o600 }); fs.chmodSync(out, 0o600);
console.log('saved pairing (endpoint ' + (offer.endpoint || '?') + ', keys: ' + Object.keys(offer).join(',') + ')');
