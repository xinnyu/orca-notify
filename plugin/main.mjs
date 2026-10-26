// agent-notify: Orca plugin worker (Orca forks it in its own process, on demand).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, decide, buildPayload, formatBody, postWithRetry, mergePending } from './core.mjs';

const DIR = path.join(os.homedir(), '.orca-notify');
const CONFIG_FILE = path.join(DIR, 'config.json');
const KEYS_DIR = path.join(DIR, 'keys');
const PENDING_DIR = path.join(DIR, 'pending');
const MAX_PANES = 500;

const DEFAULT_CONFIG = {
  _help: [
    'Minimal setup: run `bin/agent-notify add-target <name> <url>` from the plugin repo, or set "url" below.',
    'Keys: put a bearer token in ~/.orca-notify/keys/<target>.key; it is imported into Orca\'s encrypted vault and the file is deleted.',
    'Docs: https://github.com/xinnyu/orca-notify#readme',
  ],
  url: '',
  targets: {},
  rules: [],
};

export default async function activate(ctx) {
  const call = (m, p) => ctx.host.call(m, p);
  const log = (...a) => ctx.log(a.join(' '));
  const store = {
    get: async k => (await call('storage.get', { key: k }))?.value ?? null,
    set: (k, v) => call('storage.set', { key: k, value: v }),
  };
  const notify = (title, body) => call('notifications.show', { title: String(title).slice(0, 120), ...(body ? { body: String(body).slice(0, 1000) } : {}) }).catch(() => {});

  let cfg = normalizeConfig({});
  let cfgMtime = -1;

  // Read config (create a default one on first run), fold in pending drop-ins, import keys.
  async function sync() {
    fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 });
      log('created default config', CONFIG_FILE);
    }
    await absorbPending();
    const imported = await importKeys();
    const st = fs.statSync(CONFIG_FILE);
    if (st.mtimeMs !== cfgMtime) {
      cfgMtime = st.mtimeMs;
      try {
        cfg = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
        log('config loaded:', Object.keys(cfg.targets).join(',') || '(no targets)', 'default=' + cfg.defaultTarget, cfg.rules.length + ' rules');
        if (!cfg.defaultTarget && !cfg.rules.some(r => r.target)) await notify('Orca Notify: no webhook configured', `Add one: agent-notify add-target <name> <url>  (or edit ${CONFIG_FILE})`);
      } catch (e) {
        log('config error:', e.message);
        await notify('Orca Notify: config.json is invalid', e.message);
      }
    }
    return imported;
  }

  // pending/<name>.url (+ optional <name>.format, <name>.default, <name>.nokey) -> targets in config.json
  async function absorbPending() {
    let files = [];
    try { files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.url')); } catch { return; }
    if (!files.length) return;
    const rd = f => { try { return fs.readFileSync(path.join(PENDING_DIR, f), 'utf8').trim(); } catch { return null; } };
    const items = files.map(f => { const name = f.slice(0, -4); return { name, url: rd(f), format: rd(name + '.format') || undefined, makeDefault: fs.existsSync(path.join(PENDING_DIR, name + '.default')), noKey: fs.existsSync(path.join(PENDING_DIR, name + '.nokey')) }; });
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { await notify('Orca Notify: config.json is invalid', 'Fix it before adding targets: ' + e.message); return; }
    const next = mergePending(raw, items);
    if (next.url === '' ) delete next.url;
    fs.writeFileSync(CONFIG_FILE + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE);
    for (const it of items) for (const ext of ['.url', '.format', '.default', '.nokey']) fs.rmSync(path.join(PENDING_DIR, it.name + ext), { force: true });
    log('added target(s):', items.map(i => i.name).join(','));
    await notify('Orca Notify: target added', items.map(i => i.name).join(', '));
  }

  async function importKeys() {
    let n = 0, names = [];
    try { names = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.key')); } catch { return 0; }
    for (const f of names) {
      const p = path.join(KEYS_DIR, f); const key = fs.readFileSync(p, 'utf8').trim();
      if (key) { await call('secrets.set', { key: 'target:' + f.slice(0, -4), value: key }); n++; }
      fs.writeFileSync(p, ''); fs.unlinkSync(p);
    }
    if (n) log('imported', n, 'key(s) into the Orca secret vault');
    return n;
  }
  const keyFor = async t => { try { return (await call('secrets.get', { key: 'target:' + t }))?.value ?? null; } catch { return null; } };

  async function send(target, payload, { quiet = false } = {}) {
    const t = cfg.targets[target];
    const key = t.noKey ? null : await keyFor(target);
    const r = await postWithRetry(t.url, key, formatBody(t.format, payload), { retries: cfg.retries, timeoutMs: cfg.timeoutMs });
    log(`POST -> ${target}: ${r.ok ? 'ok' : 'FAILED'} status=${r.status} attempts=${r.attempts}${key ? '' : ' (no key)'}${r.error ? ' ' + r.error : ''}`);
    if (!r.ok && !quiet) await notify(`Orca Notify: delivery to "${target}" failed`, `HTTP ${r.status || '-'}${r.error ? ' ' + r.error : ''}${!key && !t.noKey ? ' (no key stored for this target)' : ''}`);
    return r;
  }

  await sync().catch(e => log('sync failed', e.message));

  // Orca may deliver events concurrently; serialize so per-pane state stays consistent.
  let chain = Promise.resolve();
  ctx.events.on('agent.status.changed', ev => (chain = chain.then(() => onStatus(ev)).catch(e => log('handler error', e.message))));
  async function onStatus(ev) {
    await sync().catch(e => log('sync failed', e.message));
    await store.set('lastEvent', ev).catch(() => {});
    const panes = (await store.get('panes')) || {};
    const d = decide(cfg, ev, panes[ev.paneKey]);
    if (ev.paneKey) {
      delete panes[ev.paneKey]; panes[ev.paneKey] = d.pane; // re-insert = most recent last
      const ks = Object.keys(panes); for (const k of ks.slice(0, Math.max(0, ks.length - MAX_PANES))) delete panes[k];
      await store.set('panes', panes);
    }
    if (!d.fire) { if (cfg.states.includes(ev.state)) log(`skip ${ev.paneKey} ${ev.state}: ${d.why}`); return; }
    const seq = ((await store.get('seq')) || 0) + 1; await store.set('seq', seq);
    await send(d.target, buildPayload(ev, d.rule, seq));
  }

  ctx.commands.register('reload', async () => {
    cfgMtime = -1; const n = await sync();
    const t = Object.keys(cfg.targets);
    await notify('Orca Notify status', `${t.length ? 'targets: ' + t.join(', ') : 'no targets'}; default: ${cfg.defaultTarget || 'none'}; ${cfg.rules.length} rules${n ? `; imported ${n} key(s)` : ''}`);
    return { targets: t, defaultTarget: cfg.defaultTarget, rules: cfg.rules.length, imported: n };
  });
  ctx.commands.register('test', async () => {
    await sync();
    const names = Object.keys(cfg.targets);
    if (!names.length) { await notify('Orca Notify test', 'No targets configured yet'); return { ok: false }; }
    const results = [];
    for (const name of names) {
      const r = await send(name, buildPayload({ paneKey: 'test', worktreeId: null, state: 'done', receivedAt: Date.now() }, { label: 'Orca Notify test' }, 0), { quiet: true });
      results.push(`${name}: ${r.ok ? 'OK' : 'FAILED'} (HTTP ${r.status || '-'})`);
    }
    await notify('Orca Notify test', results.join('; '));
    return results;
  });
  ctx.commands.register('last-event', async () => {
    const ev = await store.get('lastEvent');
    const text = ev ? `state=${ev.state} worktreeId=${ev.worktreeId} paneKey=${ev.paneKey}` : 'no agent event seen yet';
    log('last event:', text); await notify('Orca Notify: last event', text);
    return ev;
  });
  log('agent-notify active; config', CONFIG_FILE);
}

export function deactivate() {}
