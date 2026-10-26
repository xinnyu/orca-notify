// End-to-end harness: forks Orca's REAL plugin-host-entry.js (same protocol Orca uses),
// plays the host side (storage/secrets/notifications in memory), and points the plugin at a
// throwaway local HTTP receiver. Run with Orca's runtime:
//   ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca test/host-harness.mjs
import { fork } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ENTRY = process.env.PLUGIN_HOST_ENTRY || '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/main/plugin-host-entry.js';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'orca-plugin.json'), 'utf8'));

const got = [];
let failNext = 1; // first request to /flaky fails with 503 to exercise retry
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
    if (req.url === '/flaky' && failNext-- > 0) { res.statusCode = 503; return res.end(); }
    got.push({ path: req.url, auth: req.headers.authorization || null, body: JSON.parse(b) }); res.statusCode = 204; res.end();
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-notify-test-'));
fs.mkdirSync(path.join(home, '.orca-notify/keys'), { recursive: true });
fs.writeFileSync(path.join(home, '.orca-notify/config.json'), JSON.stringify({
  defaultTarget: 'bot',
  targets: { bot: { url: base + '/bot' }, flaky: { url: base + '/flaky', noKey: true } },
  rules: [{ worktreeId: 'wt-flaky', target: 'flaky', label: 'Flaky WT' }],
}));
fs.writeFileSync(path.join(home, '.orca-notify/keys/bot.key'), 'test-key-123\n');

const storage = {}, secrets = {}, notes = [], logs = [];
const host = {
  'storage.get': p => ({ value: storage[p.key] ?? null }),
  'storage.set': p => { storage[p.key] = structuredClone(p.value); return { ok: true }; },
  'secrets.get': p => ({ value: secrets[p.key] ?? null }),
  'secrets.set': p => { secrets[p.key] = p.value; return { ok: true }; },
  'notifications.show': p => { notes.push(p); return { delivered: true }; },
};
const granted = manifest.capabilities.map(c => c.kind);
const child = fork(ENTRY, [], { env: { PATH: process.env.PATH, HOME: home, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
child.stdout.on('data', d => logs.push('stdout ' + d)); child.stderr.on('data', d => logs.push('stderr ' + d));
const waiters = new Map(); let ready, acks = 0;
const readyP = new Promise((r, j) => { ready = r; setTimeout(() => j(new Error('not ready')), 10000); });
child.on('message', m => {
  if (m.type === 'ready') ready(m.commands);
  else if (m.type === 'log') logs.push(m.message);
  else if (m.type === 'fatal') { console.error('FATAL', m.error); process.exit(1); }
  else if (m.type === 'eventAck') acks++;
  else if (m.type === 'commandResult') waiters.get(m.callId)?.(m);
  else if (m.type === 'hostCall') {
    const h = host[m.method]; const cap = { 'storage.get': 'storage', 'storage.set': 'storage', 'secrets.get': 'secrets', 'secrets.set': 'secrets', 'notifications.show': 'notifications:show' }[m.method];
    if (!h || !granted.includes(cap)) child.send({ type: 'hostResult', callId: m.callId, ok: false, errorCode: 'capability_denied', error: 'denied ' + m.method });
    else child.send({ type: 'hostResult', callId: m.callId, ok: true, value: h(m.params) });
  }
});
child.send({ type: 'init', pluginId: `${manifest.publisher}.${manifest.id}`, pluginRoot: ROOT, mainEntry: manifest.main, grantedCapabilities: granted });
const commands = await readyP;
let eid = 0, cid = 0;
const ev = (worktreeId, paneKey, state, extra = {}) => child.send({ type: 'deliverEvent', eventId: eid++, event: 'agent.status.changed', payload: { worktreeId, paneKey, state, receivedAt: Date.now(), ...extra } });
const cmd = id => new Promise(r => { const c = cid++; waiters.set(c, r); child.send({ type: 'invokeCommand', callId: c, commandId: id }); });
const settle = ms => new Promise(r => setTimeout(r, ms));

ev('wt1', 't1:l1', 'working');
ev('wt1', 't1:l1', 'done', { mainAgent: { state: 'done', stateStartedAt: 1 } });
ev('wt1', 't1:l1', 'done');            // duplicate -> deduped
ev('wt1', 't1:l2', 'blocked');
ev('wt-flaky', 't2:l1', 'waiting');   // routed to flaky (503 then retry)
await settle(4000);
const t = await cmd('test'); const le = await cmd('last-event');
await settle(500);

try {
  assert.deepEqual(commands.sort(), ['last-event', 'reload', 'test']);
  assert.equal(secrets['target:bot'], 'test-key-123', 'key imported into vault');
  assert.equal(fs.existsSync(path.join(home, '.orca-notify/keys/bot.key')), false, 'plaintext key removed');
  const bot = got.filter(g => g.path === '/bot');
  assert.deepEqual(bot.map(g => g.body.agentState), ['done', 'blocked', 'done'], 'done, blocked, test (dedupe ok)');
  assert.ok(bot.every(g => g.auth === 'Bearer test-key-123'), 'bearer');
  const fl = got.filter(g => g.path === '/flaky');
  assert.equal(fl.length, 1); assert.equal(fl[0].auth, null); assert.equal(fl[0].body.label, 'Flaky WT');
  assert.equal(t.ok, true); assert.equal(le.value.paneKey, 't2:l1');
  assert.equal(acks, 5);
  console.log('PASS: real plugin-host-entry, %d webhook deliveries, %d notifications', got.length, notes.length);
  console.log(JSON.stringify(bot[0].body));
} catch (e) { console.error('FAIL', e.message); console.error(logs.join('\n')); process.exitCode = 1; }
finally { child.send({ type: 'shutdown' }); srv.close(); fs.rmSync(home, { recursive: true, force: true }); setTimeout(() => process.exit(), 300); }
