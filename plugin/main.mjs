// orca-notify: Orca plugin worker. Runs in a separate process forked by Orca.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, decide, buildPayload, postWithRetry } from './core.mjs';

const CONFIG_DIR = process.env.ORCA_NOTIFY_CONFIG_DIR || path.join(os.homedir(), '.orca-notify');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KEYS_DIR = path.join(CONFIG_DIR, 'keys');
const MAX_PANES = 500;

export default async function activate(ctx) {
  const call = (m, p) => ctx.host.call(m, p);
  const log = (...a) => ctx.log(a.join(' '));
  const store = {
    get: async k => (await call('storage.get', { key: k }))?.value ?? null,
    set: (k, v) => call('storage.set', { key: k, value: v }),
  };
  const notify = (title, body) => call('notifications.show', { title: title.slice(0, 120), ...(body ? { body: body.slice(0, 1000) } : {}) }).catch(() => {});

  let cfg = normalizeConfig({});
  function loadConfig() {
    try { cfg = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); log('config loaded:', Object.keys(cfg.targets).length, 'targets,', cfg.rules.length, 'rules'); }
    catch (e) { cfg = normalizeConfig({}); log('no usable config at', CONFIG_FILE, '-', e.code || e.message); }
  }

  // Move plaintext key files (~/.orca-notify/keys/<target>.key) into Orca's encrypted plugin vault.
  async function importKeys() {
    let n = 0; let names = [];
    try { names = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.key')); } catch { return 0; }
    for (const f of names) {
      const p = path.join(KEYS_DIR, f); const key = fs.readFileSync(p, 'utf8').trim();
      if (!key) continue;
      await call('secrets.set', { key: 'target:' + f.slice(0, -4), value: key });
      fs.writeFileSync(p, ''); fs.unlinkSync(p); n++;
    }
    if (n) log('imported', n, 'key(s) into the Orca secret vault');
    return n;
  }
  async function keyFor(target) {
    try { return (await call('secrets.get', { key: 'target:' + target }))?.value ?? null; } catch { return null; }
  }

  async function send(target, body) {
    const t = cfg.targets[target];
    const key = t.noKey ? null : await keyFor(target);
    if (!t.noKey && !key) log(`warning: no key for target ${target}; sending without Authorization`);
    const r = await postWithRetry(t.url, key, body, { retries: cfg.retries, timeoutMs: cfg.timeoutMs });
    log(`POST -> ${target}: ${r.ok ? 'ok' : 'FAILED'} status=${r.status} attempts=${r.attempts}${r.error ? ' ' + r.error : ''}`);
    return r;
  }

  loadConfig();
  await importKeys().catch(e => log('key import failed', e.message));

  // Orca may deliver events concurrently; serialize so dedupe state stays consistent.
  let chain = Promise.resolve();
  ctx.events.on('agent.status.changed', ev => (chain = chain.then(() => onStatus(ev)).catch(e => log('handler error', e.message))));
  async function onStatus(ev) {
    await store.set('lastEvent', ev).catch(() => {});
    const prev = (await store.get('paneStates')) || {};
    const d = decide(cfg, ev, prev[ev.paneKey]);
    if (ev.paneKey) {
      prev[ev.paneKey] = ev.state;
      const keys = Object.keys(prev); if (keys.length > MAX_PANES) for (const k of keys.slice(0, keys.length - MAX_PANES)) delete prev[k];
      await store.set('paneStates', prev);
    }
    if (!d.fire) { if (cfg.states.includes(ev.state)) log(`skip ${ev.paneKey} ${ev.state}: ${d.why}`); return; }
    const seq = ((await store.get('seq')) || 0) + 1; await store.set('seq', seq);
    await send(d.target, buildPayload(ev, d.rule, seq));
  }

  ctx.commands.register('reload', async () => {
    loadConfig(); const n = await importKeys();
    await notify('Orca Notify reloaded', `${Object.keys(cfg.targets).length} targets, ${cfg.rules.length} rules, ${n} key(s) imported`);
    return { targets: Object.keys(cfg.targets), rules: cfg.rules.length, imported: n };
  });
  ctx.commands.register('test', async () => {
    loadConfig();
    const target = cfg.defaultTarget;
    if (!target || !cfg.targets[target]) { await notify('Orca Notify', 'No defaultTarget configured'); return { ok: false }; }
    const r = await send(target, buildPayload({ paneKey: 'test', worktreeId: null, state: 'done', receivedAt: Date.now() }, { label: 'orca-notify test' }, 0));
    await notify('Orca Notify test', `${target}: ${r.ok ? 'delivered' : 'failed'} (HTTP ${r.status})`);
    return r;
  });
  ctx.commands.register('last-event', async () => {
    const ev = await store.get('lastEvent');
    const text = ev ? `state=${ev.state} worktreeId=${ev.worktreeId} paneKey=${ev.paneKey}` : 'no agent event seen yet';
    log('last event:', text); await notify('Orca Notify: last event', text);
    return ev;
  });
  log('orca-notify active; config', CONFIG_FILE);
}

export function deactivate() {}
