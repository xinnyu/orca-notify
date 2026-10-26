// orca-notify listener: subscribes to a local Orca runtime's notification stream and
// POSTs a JSON event to a webhook when a watched pane's agent finishes / blocks / waits.
'use strict';
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');

const HOME = process.env.HOME || require('os').homedir();
const D = process.env.ORCA_NOTIFY_DIR || path.join(HOME, '.orca-notify');
const ORCA_APP = process.env.ORCA_APP || '/Applications/Orca.app';
const OUT = process.env.ORCA_OUT_DIR || path.join(ORCA_APP, 'Contents/Resources/app.asar.unpacked/out');
const F = {
  state: path.join(D, 'state.json'), watch: path.join(D, 'watch.json'), routes: path.join(D, 'routes.json'),
  events: path.join(D, 'events.jsonl'), pairing: path.join(D, '.pairing.json'), wake: path.join(D, 'wake.sh'),
};
const TRIGGER_STATES = (process.env.ORCA_NOTIFY_STATES || 'done,blocked,waiting').split(',');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 1)); fs.renameSync(f + '.tmp', f); };

let state = rj(F.state, { lastSeenSeq: 0, epoch: null });
// NOTE: internal Orca module, not a public API. Tested with Orca 1.4.240 / 1.4.241.
const { subscribeRemoteRuntimeRequest, sendRemoteRuntimeRequest } = require(path.join(OUT, 'shared/remote-runtime-client'));

// Newer Orca builds take {endpoint, credential:{deviceToken}, hostPublicKeyB64}; older ones take the raw offer. Provide both.
const pairing = () => {
  const p = JSON.parse(fs.readFileSync(F.pairing, 'utf8'));
  return { ...p, credential: { kind: 'token', deviceToken: p.deviceToken }, hostPublicKeyB64: p.publicKeyB64 };
};
const call = async (method, params, ms = 20000) => {
  const r = await sendRemoteRuntimeRequest(pairing(), method, params, ms);
  if (r.ok === false) throw new Error(JSON.stringify(r.error));
  return r.result;
};

async function termMap() {
  try { const r = await call('terminal.list', {}); const m = {};
    for (const t of r.terminals || []) m[t.handle] = t.tabId + ':' + t.leafId; return m;
  } catch (e) { log('terminal.list failed', e.message); return {}; }
}

// watch.json: { "<paneKey|term_handle>": {label, target?} }
// routes.json: { default?: name, targets: {name:{url,keyFile}}, byWorktree?: {id:name}, byRepo?: {id:name} }
async function match(n) {
  const w = rj(F.watch, {}); const ks = Object.keys(w);
  if (!ks.length || !n.paneKey) return null;
  for (const k of ks) if (k === n.paneKey) return { key: k, ...w[k] };
  if (!ks.some(k => k.startsWith('term_'))) return null;
  const tm = await termMap();
  for (const k of ks) if (tm[k] === n.paneKey) return { key: k, ...w[k] };
  return null;
}
function resolveTarget(m, n) {
  const r = rj(F.routes, { targets: {} });
  const name = m.target || (r.byWorktree || {})[n.worktreeId] || (r.byRepo || {})[n.repoId] || r.default;
  const t = name && (r.targets || {})[name];
  return t ? { name, ...t } : null;
}

const seen = new Set();
async function handle(n, via) {
  if (typeof n.notificationSeq === 'number') {
    if (state.epoch && n.notificationEpoch && n.notificationEpoch !== state.epoch) { log('epoch changed -> reset seq'); state.lastSeenSeq = 0; }
    if (n.notificationEpoch) state.epoch = n.notificationEpoch;
    if (n.notificationSeq <= state.lastSeenSeq && via !== 'live') return;
    state.lastSeenSeq = Math.max(state.lastSeenSeq, n.notificationSeq); wj(F.state, state);
  }
  if (n.type !== 'notification') return;
  const id = n.notificationId || String(n.notificationSeq);
  if (seen.has(id)) return; seen.add(id);
  if (seen.size > 5000) seen.clear();
  log(`[${via}] seq=${n.notificationSeq} state=${n.agentState} src=${n.source} pane=${n.paneKey}`);
  const m = await match(n); if (!m) return;
  if (!TRIGGER_STATES.includes(n.agentState) && n.source !== 'agent-task-complete') { log('  state ignored'); return; }
  const ev = { time: new Date(n.emittedAt || Date.now()).toISOString(), label: m.label || m.key, watchKey: m.key,
    agentState: n.agentState || null, title: n.title, body: n.body, paneKey: n.paneKey, worktreeId: n.worktreeId,
    seq: n.notificationSeq, source: n.source };
  fs.appendFileSync(F.events, JSON.stringify(ev) + '\n');
  const t = resolveTarget(m, n);
  if (!t) { log('  MATCH', ev.label, 'but no target configured (see routes.json)'); return; }
  log('  MATCH', ev.label, '-> target', t.name);
  const p = spawn('/bin/bash', [F.wake, t.url, t.keyFile || '']);
  p.stdin.end(JSON.stringify(ev));
  p.stdout.on('data', d => log('  wake:', String(d).trim()));
  p.stderr.on('data', d => log('  wake err:', String(d).trim()));
  p.on('exit', c => log('  wake exit', c));
}

async function catchUp() {
  const r = await call('notifications.getMissedSince', { lastSeenSeq: state.lastSeenSeq, ...(state.epoch ? { epoch: state.epoch } : {}) });
  if (r.epoch && state.epoch && r.epoch !== state.epoch) { log('epoch reset on catch-up'); state.lastSeenSeq = 0; state.epoch = r.epoch; }
  const ns = r.notifications || []; log('catch-up:', ns.length, 'since seq', state.lastSeenSeq);
  for (const n of ns) await handle(n, 'missed');
}

let backoff = 2000, quiet = 0;
async function loop() {
  for (;;) {
    let closed; const done = new Promise(r => (closed = r));
    try {
      const sub = await subscribeRemoteRuntimeRequest(pairing(), 'notifications.subscribe', {}, 30000, {
        onResponse: (resp) => {
          if (resp.ok === false) { log('stream error', JSON.stringify(resp.error)); closed(); return; }
          const x = resp.result;
          if (x?.type === 'ready') { log('subscribed', x.subscriptionId, 'epoch', x.epoch); backoff = 2000; quiet = 0;
            catchUp().catch(e => log('catch-up failed', e.message)); return; }
          if (x?.type === 'end') { log('stream end'); closed(); return; }
          handle(x, 'live').catch(e => log('handle err', e.message));
        },
        onError: (e) => log('stream onError', e.code || '', e.message),
        onClose: () => { log('stream closed'); closed(); },
      });
      await done; try { sub.close(); } catch {}
    } catch (e) { if (quiet < 3 || quiet % 30 === 0) log('connect failed (Orca not running / not paired?)', e.code || '', e.message); quiet++; }
    await new Promise(r => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 60000);
  }
}
process.on('uncaughtException', e => { log('uncaught', e.stack || e); process.exit(1); });
log('listener start dir', D, 'lastSeenSeq', state.lastSeenSeq); loop();
