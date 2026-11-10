// Send remote keys to the TV over its Wi-Fi remote API (port 8002).
// Usage: node tools/tv.js KEY_1 KEY_2 ...   (no keys = just pair; the TV shows an "Allow" prompt once)
//        node tools/tv.js --ip 192.168.1.20  (Developer Mode "Host PC IP": with the first box focused,
//                                             types each part with KEY_RIGHT between the four boxes)
//        node tools/tv.js --text "hello"     (types into a text box that uses the TV's own keyboard)
// Options and keys can be mixed and run in order, e.g. --ip 192.168.1.20 KEY_ENTER.
// Handy for remotes without number buttons, e.g. Developer Mode: open Apps > App Settings, then
//   node tools/tv.js KEY_1 KEY_2 KEY_3 KEY_4 KEY_5
const { settings, readPairing, savePairing, openRemote } = require('./lib');

const USAGE = 'usage: node tools/tv.js [KEY_... | --ip a.b.c.d | --text "..."] ...';

// The Host PC IP boxes don't move on by themselves after three digits, and extra digits are
// dropped, so every part is followed by KEY_RIGHT (except the last).
function ipKeys(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    throw new Error(`--ip needs an address like 192.168.1.20 (got "${ip}")`);
  }
  return parts.flatMap((p, i) => [...String(Number(p))].map((d) => `KEY_${d}`).concat(i < 3 ? ['KEY_RIGHT'] : []));
}

function parseArgs(argv) {
  const steps = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ip' || a === '--text') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      const v = argv[++i];
      if (a === '--ip') steps.push(...ipKeys(v).map((key) => ({ key })));
      else steps.push({ text: v });
    } else if (/^KEY_[A-Z0-9_]+$/.test(a)) {
      steps.push({ key: a });
    } else {
      throw new Error(`unknown argument "${a}"`);
    }
  }
  return steps;
}

function main() {
  let steps;
  try { steps = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(1); }

  const TV_IP = settings().ip;
  const NAME = Buffer.from('TVLauncherSetup').toString('base64');
  const KEY_DELAY_MS = Number(process.env.KEY_DELAY_MS || 600);
  const HOLD = process.env.HOLD === '1'; // send Press/Release pairs instead of Click
  const HOLD_MS = Number(process.env.HOLD_MS || 250);
  const savedToken = readPairing(TV_IP).token || '';

  let url = `wss://${TV_IP}:8002/api/v2/channels/samsung.remote.control?name=${NAME}`;
  if (savedToken) url += `&token=${savedToken}`;

  const ws = openRemote(url);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const timeout = setTimeout(() => {
    console.error('Timed out waiting for the TV. If an "Allow" prompt is showing on the TV, accept it and run again.');
    process.exit(1);
  }, 45000);

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.event === 'ms.channel.unauthorized') {
      console.error('TV rejected the connection (Allow was denied, or this device is blocked in TV settings).');
      process.exit(1);
    }
    if (msg.event !== 'ms.channel.connect') return;
    clearTimeout(timeout);

    const token = msg.data && msg.data.token;
    if (token && token !== savedToken) {
      savePairing({ token }, TV_IP);
      console.log(`Paired; token for ${TV_IP} saved to tv-token.json`);
    } else {
      console.log('Connected');
    }

    const send = (params) => ws.send(JSON.stringify({ method: 'ms.remote.control', params }));
    const key = (cmd, k) => send({ Cmd: cmd, DataOfCmd: k, Option: 'false', TypeOfRemote: 'SendRemoteKey' });

    for (const s of steps) {
      if (s.text !== undefined) {
        // same as the phone remote: base64 text, then end input so the TV closes its keyboard
        send({ Cmd: Buffer.from(s.text, 'utf8').toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' });
        send({ Cmd: '', DataOfCmd: '', TypeOfRemote: 'SendInputEnd' });
        console.log(`Sent text (${s.text.length} characters)`);
      } else if (HOLD) {
        key('Press', s.key);
        await sleep(HOLD_MS);
        key('Release', s.key);
        console.log(`Sent ${s.key}`);
      } else {
        key('Click', s.key);
        console.log(`Sent ${s.key}`);
      }
      await sleep(KEY_DELAY_MS);
    }
    ws.close();
  });

  ws.on('error', (err) => {
    console.error('Connection error:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, ipKeys };
if (require.main === module) main();
