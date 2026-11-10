// Shared settings for the tools. Your TV's address lives in tv.json at the repo root (gitignored,
// written by `npm run find-tv`) or in the TV_IP environment variable.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Tizen Studio lives in ~/tizen-studio unless TIZEN_STUDIO points elsewhere
const STUDIO = process.env.TIZEN_STUDIO || path.join(os.homedir(), 'tizen-studio');
const TIZEN = path.join(STUDIO, 'tools/ide/bin/tizen');
const SDB = path.join(STUDIO, 'tools/sdb');

function tvFile() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'tv.json'), 'utf8')); } catch (e) { return {}; }
}

function settings() {
  const file = tvFile();
  const ip = process.env.TV_IP || file.ip;
  if (!ip) {
    console.error('No TV address. Run `npm run find-tv` (or set TV_IP).');
    process.exit(1);
  }
  return { ip, certProfile: process.env.CERT_PROFILE || file.certProfile || 'tv' };
}

// App id from launcher/config.xml, e.g. "TVLauncher.Launcher"
function appId() {
  const xml = fs.readFileSync(path.join(ROOT, 'launcher/config.xml'), 'utf8');
  return /<tizen:application id="([^"]+)"/.exec(xml)[1];
}

// Pairing with each TV: its token, and the fingerprint of its certificate, keyed by the TV's IP
// ({ "192.168.1.50": { token, fp } }) so several TVs can be paired. Readable only by you.
const PAIRING = process.env.TV_TOKEN_FILE || path.join(ROOT, 'tv-token.json');
// A missing file means not paired yet. A broken one is an error, so the certificate check
// never quietly starts over.
function readAllPairings() {
  let text;
  try { text = fs.readFileSync(PAIRING, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  let data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${PAIRING} is unreadable. Delete it and pair again (npm run pair).`);
  // Older files held one TV's { token, fp } at the top level. That TV is the one in tv.json;
  // the file is rewritten in the keyed form the next time anything is saved.
  if (typeof data.token === 'string' || typeof data.fp === 'string') {
    const ip = tvFile().ip || process.env.TV_IP;
    if (!ip) throw new Error(`${PAIRING} is from an older version and tv.json has no IP. Run \`npm run find-tv\` first.`);
    const legacy = {};
    if (data.token) legacy.token = data.token;
    if (data.fp) legacy.fp = data.fp;
    return { [ip]: legacy };
  }
  return data;
}
function readPairing(ip = settings().ip) {
  return readAllPairings()[ip] || {};
}
function savePairing(update, ip = settings().ip) {
  const all = readAllPairings();
  all[ip] = { ...all[ip], ...update };
  fs.writeFileSync(PAIRING, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(PAIRING, 0o600);
}

// Opens the TV's remote-control WebSocket. The TV's certificate is self-signed, so it can't be
// checked the usual way. Instead its fingerprint is saved the first time and must match after
// that. The check runs before the request (which carries the token) is sent.
function openRemote(url) {
  const WebSocket = require('ws');
  const tls = require('tls');
  return new WebSocket(url, {
    createConnection(opts, done) {
      const ip = opts.host;
      const socket = tls.connect({ host: ip, port: opts.port, rejectUnauthorized: false });
      socket.once('error', done);
      socket.once('secureConnect', () => {
        const fp = socket.getPeerCertificate().fingerprint256;
        let saved;
        try { saved = readPairing(ip).fp; } catch (e) { socket.destroy(); return done(e); }
        if (saved && saved !== fp) {
          socket.destroy();
          return done(new Error(`The certificate of the TV at ${ip} changed. If you replaced the TV, delete its entry in tv-token.json and pair again.`));
        }
        if (!saved) savePairing({ fp }, ip);
        done(null, socket);
      });
    }
  });
}

module.exports = { ROOT, TIZEN, SDB, settings, appId, readPairing, savePairing, openRemote };

// `node tools/lib.js ip|app|cert|sdb|tizen` prints a value for shell scripts
if (require.main === module) {
  const what = process.argv[2];
  if (what === 'app') console.log(appId());
  else if (what === 'sdb') console.log(SDB);
  else if (what === 'tizen') console.log(TIZEN);
  else if (what === 'cert') console.log(settings().certProfile);
  else console.log(settings().ip);
}
