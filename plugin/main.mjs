// agent-notify: Orca plugin worker (Orca forks it in its own process, on demand).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, decide, buildPayload, formatBody, postWithRetry, mergePending, failureHint } from './core.mjs';

const DIR = path.join(os.homedir(), '.orca-notify');
const CONFIG_FILE = path.join(DIR, 'config.json');
const KEYS_DIR = path.join(DIR, 'keys');
const PENDING_DIR = path.join(DIR, 'pending');
const MAX_PANES = 500;

const DEFAULT_CONFIG = {
  _help: [
    'Minimal setup: set "url" below (and optionally put a bearer token in ~/.orca-notify/keys/default.key),',
    'or run `agent-notify add-target <name> <url>`. Docs: https://github.com/xinnyu/orca-notify#readme',
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
  let cfgError = null;

  // Read config (create a default one on first run), fold in pending drop-ins, import keys, prune keys of removed targets.
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
        cfgError = null;
        log('config loaded:', Object.keys(cfg.targets).join(',') || '(no targets)', 'default=' + cfg.defaultTarget, cfg.rules.length + ' rules');
        await pruneKeys();
        if (!cfg.defaultTarget && !cfg.rules.some(r => r.target)) await notify('Orca Notify: no webhook configured', `Add one: agent-notify add-target <name> <url>  (or set "url" in ${CONFIG_FILE})`);
      } catch (e) {
        cfgError = e.message;
        log('config error:', e.message);
        await notify('Orca Notify: config.json is invalid', e.message);
      }
    }
    return imported;
  }

  // pending/<name>.url (+ .format/.default/.nokey) adds a target; pending/<name>.remove removes one.
  async function absorbPending() {
    let files = [];
    try { files = fs.readdirSync(PENDING_DIR); } catch { return; }
    const names = [...new Set(files.filter(f => /\.(url|remove)$/.test(f)).map(f => f.replace(/\.(url|remove)$/, '')))];
    if (!names.length) return;
    const P = f => path.join(PENDING_DIR, f);
    const rd = f => { try { return fs.readFileSync(P(f), 'utf8').trim(); } catch { return null; } };
    const mt = f => { try { return fs.statSync(P(f)).mtimeMs; } catch { return 0; } };
    const items = names.map(name => ({
      name, url: rd(name + '.url'), format: rd(name + '.format') || undefined,
      makeDefault: fs.existsSync(P(name + '.default')), noKey: fs.existsSync(P(name + '.nokey')),
      remove: fs.existsSync(P(name + '.remove')),
      order: Number(rd(name + '.order')) || mt(name + '.url') || mt(name + '.remove'),
    }));
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { await notify('Orca Notify: config.json is invalid', 'Fix it before adding targets: ' + e.message); return; }
    const { config, removed } = mergePending(raw, items);
    if (config.url === '') delete config.url;
    fs.writeFileSync(CONFIG_FILE + '.tmp', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE);
    for (const it of items) for (const ext of ['.url', '.format', '.default', '.nokey', '.remove', '.order']) fs.rmSync(P(it.name + ext), { force: true });
    const added = items.filter(i => !i.remove).map(i => i.name);
    if (added.length) { log('added target(s):', added.join(',')); await notify('Orca Notify: target added', added.join(', ') + (config.defaultTarget ? ` (default: ${config.defaultTarget})` : '')); }
    if (removed.length) { log('removed target(s):', removed.join(',')); await notify('Orca Notify: target removed', removed.join(', ')); }
  }

  async function importKeys() {
    let n = 0, names = [];
    try { names = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.key')); } catch { return 0; }
    const stored = new Set((await store.get('keyNames')) || []);
    for (const f of names) {
      const p = path.join(KEYS_DIR, f); const key = fs.readFileSync(p, 'utf8').trim(); const name = f.slice(0, -4);
      if (key) { await call('secrets.set', { key: 'target:' + name, value: key }); stored.add(name); n++; }
      fs.writeFileSync(p, ''); fs.unlinkSync(p);
    }
    if (n) { await store.set('keyNames', [...stored]); log('imported', n, 'key(s) into the Orca secret vault'); }
    return n;
  }
  // Delete vault keys whose target no longer exists (only after a successful config parse).
  async function pruneKeys() {
    const stored = (await store.get('keyNames')) || [];
    const keep = stored.filter(n => cfg.targets[n]);
    for (const n of stored) if (!cfg.targets[n]) { await call('secrets.delete', { key: 'target:' + n }).catch(() => {}); log('deleted stored key of removed target', n); }
    if (keep.length !== stored.length) await store.set('keyNames', keep);
  }
  const keyFor = async t => { try { return (await call('secrets.get', { key: 'target:' + t }))?.value ?? null; } catch { return null; } };

  async function send(target, payload, { quiet = false } = {}) {
    const t = cfg.targets[target];
    const key = t.noKey ? null : await keyFor(target);
    const r = await postWithRetry(t.url, key, formatBody(t.format, payload), { retries: cfg.retries, timeoutMs: cfg.timeoutMs });
    r.hint = failureHint(r, { hasKey: !!key, noKey: t.noKey, target });
    log(`POST -> ${target}: ${r.ok ? 'ok' : 'FAILED'} status=${r.status} attempts=${r.attempts}${key ? '' : ' (no key)'}${r.error ? ' ' + r.error : ''}`);
    if (!r.ok && !quiet) await notify(`Orca Notify: delivery to "${target}" failed`, r.hint);
    return r;
  }

  await sync().catch(e => log('sync failed', e.message));

  // State bookkeeping is serialized (consistent per-pane state); deliveries run in the background
  // so a slow or dead target never delays other notifications.
  let chain = Promise.resolve();
  const inflight = new Set();
  ctx.events.on('agent.status.changed', ev => (chain = chain.then(() => onStatus(ev)).catch(e => log('handler error', e.message))));
  async function onStatus(ev) {
    await sync().catch(e => log('sync failed', e.message));
    await store.set('lastEvent', ev).catch(() => {});
    const panes = (await store.get('panes')) || {};
    const d = decide(cfg, ev, panes[ev.paneKey]);
    if (ev.paneKey) {
      delete panes[ev.paneKey]; panes[ev.paneKey] = d.pane;
      const ks = Object.keys(panes); for (const k of ks.slice(0, Math.max(0, ks.length - MAX_PANES))) delete panes[k];
      await store.set('panes', panes);
    }
    if (!d.fire) { if (cfg.states.includes(ev.state)) log(`skip ${ev.paneKey} ${ev.state}: ${d.why}`); return; }
    const seq = ((await store.get('seq')) || 0) + 1; await store.set('seq', seq);
    const job = send(d.target, buildPayload(ev, d.rule, seq)).catch(e => log('send error', e.message)).finally(() => inflight.delete(job));
    inflight.add(job);
  }

  ctx.commands.register('reload', async () => {
    cfgMtime = -1; const n = await sync();
    if (cfgError) { await notify('Orca Notify: config.json is invalid', cfgError); return { ok: false, error: cfgError }; }
    const t = Object.keys(cfg.targets);
    await notify('Orca Notify status', `${t.length ? 'targets: ' + t.join(', ') : 'no targets'}; default: ${cfg.defaultTarget || 'none'}; ${cfg.rules.length} rules${n ? `; imported ${n} key(s)` : ''}`);
    return { targets: t, defaultTarget: cfg.defaultTarget, rules: cfg.rules.length, imported: n };
  });
  ctx.commands.register('test', async () => {
    cfgMtime = -1; await sync();
    if (cfgError) { await notify('Orca Notify test: config.json is invalid', cfgError); return { ok: false, error: cfgError }; }
    const names = Object.keys(cfg.targets);
    if (!names.length) { await notify('Orca Notify test', 'No targets configured yet. Run: agent-notify add-target <name> <url>'); return { ok: false }; }
    const payload = buildPayload({ paneKey: 'test', worktreeId: null, state: 'done', receivedAt: Date.now() }, { label: 'Orca Notify test' }, 0);
    const rs = await Promise.all(names.map(n => send(n, payload, { quiet: true })));
    const results = names.map((n, i) => `${n}: ${rs[i].ok ? 'OK' : 'FAILED (' + rs[i].hint + ')'}`);
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

export async function deactivate() {}
