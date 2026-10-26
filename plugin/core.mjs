// Pure logic for agent-notify (no Orca host dependencies) so it can be unit-tested.

export const DEFAULT_STATES = ['done', 'blocked', 'waiting'];
export const FORMATS = ['generic', 'slack', 'discord'];

/**
 * Normalize a user config. Minimal valid config: { "url": "https://..." }
 * (becomes target "default"). Full form: { targets: {name:{url,format,noKey}}, defaultTarget, rules, ... }.
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const targets = {};
  for (const [n, t] of Object.entries(c.targets && typeof c.targets === 'object' ? c.targets : {})) {
    if (t && typeof t.url === 'string' && t.url) targets[n] = { url: t.url, format: FORMATS.includes(t.format) ? t.format : 'generic', noKey: !!t.noKey };
  }
  if (typeof c.url === 'string' && c.url) targets.default = { url: c.url, format: FORMATS.includes(c.format) ? c.format : 'generic', noKey: !!c.noKey };
  let defaultTarget = typeof c.defaultTarget === 'string' ? c.defaultTarget : null;
  if (!defaultTarget && targets.default) defaultTarget = 'default';
  if (!defaultTarget && Object.keys(targets).length === 1) defaultTarget = Object.keys(targets)[0];
  return {
    states: Array.isArray(c.states) && c.states.length ? c.states.map(String) : DEFAULT_STATES,
    watch: c.watch === 'listed' ? 'listed' : 'all',
    defaultTarget,
    targets,
    rules: Array.isArray(c.rules) ? c.rules.filter(r => r && typeof r === 'object') : [],
    retries: Number.isInteger(c.retries) ? Math.max(0, Math.min(c.retries, 5)) : 2,
    timeoutMs: Number.isInteger(c.timeoutMs) ? c.timeoutMs : 5000,
    watchTtlHours: Number.isFinite(c.watchTtlHours) && c.watchTtlHours > 0 ? c.watchTtlHours : 24,
  };
}

/** Orca worktree ids look like "<repoId>::<absolute path>". */
export function splitWorktreeId(id) {
  if (typeof id !== 'string') return { repoId: null, path: null };
  const i = id.indexOf('::');
  return i < 0 ? { repoId: id, path: null } : { repoId: id.slice(0, i), path: id.slice(i + 2) };
}

/** Most specific rule wins: paneKey > worktreeId > pathPrefix > repoId. */
export function findRule(cfg, ev) {
  const { repoId, path } = splitWorktreeId(ev.worktreeId);
  const under = (p, pre) => p && (p === pre || p.startsWith(pre.replace(/\/$/, '') + '/'));
  return cfg.rules.find(r => r.paneKey && r.paneKey === ev.paneKey)
    || cfg.rules.find(r => r.worktreeId && r.worktreeId === ev.worktreeId)
    || cfg.rules.find(r => r.pathPrefix && under(path, r.pathPrefix))
    || cfg.rules.find(r => r.repoId && r.repoId === repoId)
    || null;
}

/**
 * Per-pane state machine. `pane` = {state, armed}. A pane is "armed" once it is seen working;
 * done/waiting only notify when armed (this drops the idle "done" a fresh session reports before
 * any work). blocked notifies immediately (once per entry into blocked).
 * Returns {fire, why, target, rule, pane: nextPaneState}.
 */
export function decide(cfg, ev, pane) {
  const prev = pane || { state: null, armed: false };
  if (!ev || typeof ev.paneKey !== 'string') return { fire: false, why: 'no paneKey', pane: prev };
  const state = ev.state;
  const next = { state, armed: prev.armed || state === 'working' };
  const no = why => ({ fire: false, why, pane: next });
  if (!cfg.states.includes(state)) return no(`state ${state} not watched`);
  if (prev.state === state) return no('unchanged state');
  if (state !== 'blocked') {
    if (!prev.armed) return no('pane not seen working since last notification');
    next.armed = false;
  }
  const rule = findRule(cfg, ev);
  if (rule && rule.mute) return no('muted by rule');
  if (cfg.watch === 'listed' && !rule) return no('not in rules (watch=listed)');
  const target = (rule && rule.target) || cfg.defaultTarget;
  if (!target || !cfg.targets[target]) return no(`no target (${target || 'none'})`);
  return { fire: true, target, rule, pane: next };
}

/** Webhook body (generic): same field names as the legacy listener where available. */
export function buildPayload(ev, rule, seq) {
  const { path } = splitWorktreeId(ev.worktreeId);
  const label = (rule && rule.label) || (path ? path.split('/').filter(Boolean).slice(-2).join('/') : null) || ev.paneKey;
  return {
    time: new Date(ev.receivedAt || Date.now()).toISOString(),
    label,
    watchKey: rule ? (rule.paneKey || rule.worktreeId || rule.pathPrefix || rule.repoId || null) : null,
    agentState: ev.state,
    title: `Agent ${ev.state}${label ? ': ' + label : ''}`,
    body: ev.mainAgent && ev.mainAgent.outcome ? `outcome: ${ev.mainAgent.outcome}` : null,
    paneKey: ev.paneKey,
    worktreeId: ev.worktreeId ?? null,
    seq,
    source: 'orca-plugin',
    mainAgent: ev.mainAgent ?? null,
  };
}

/** Adapt the generic payload for chat webhooks. */
export function formatBody(format, p) {
  const text = `${p.title}${p.body ? ` (${p.body})` : ''}`;
  if (format === 'slack') return { text, orca: p };
  if (format === 'discord') return { content: text };
  return p;
}

/** POST JSON with Bearer auth and small exponential-backoff retry. Returns {ok,status,attempts,error}. */
export async function postWithRetry(url, key, body, { retries = 2, timeoutMs = 5000, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last = { ok: false, status: 0, attempts: 0, error: null };
  for (let i = 0; i <= retries; i++) {
    if (i) await sleep(1000 * 2 ** (i - 1));
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      last = { ok: res.ok, status: res.status, attempts: i + 1, error: null };
      if (res.ok) return last;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return last;
    } catch (e) { last = { ok: false, status: 0, attempts: i + 1, error: String(e && e.message || e) }; }
    finally { clearTimeout(t); }
  }
  return last;
}

/**
 * Merge "pending" drop-in files into a raw config object (pure; caller does the IO).
 * pending: [{name, url?, format?, makeDefault?, noKey?, remove?, order}] — applied in `order`
 * (the time the user ran add-target), so the FIRST target ever added becomes the default.
 * Returns {config, removed: [names]}.
 */
export function mergePending(raw, pending) {
  const c = raw && typeof raw === 'object' ? { ...raw } : {};
  c.targets = { ...(c.targets || {}) };
  const removed = [];
  for (const p of [...pending].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(p.name)) continue;
    if (p.remove) {
      delete c.targets[p.name]; removed.push(p.name);
      if (c.defaultTarget === p.name) delete c.defaultTarget;
      continue;
    }
    if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) continue;
    c.targets[p.name] = { url: p.url, ...(FORMATS.includes(p.format) && p.format !== 'generic' ? { format: p.format } : {}), ...(p.noKey ? { noKey: true } : {}) };
    if (p.makeDefault || (!c.defaultTarget && !c.url)) c.defaultTarget = p.name;
  }
  return { config: c, removed };
}

/** Short user-facing hint for a failed delivery. */
export function failureHint(r, { hasKey, noKey, target }) {
  if (r.status === 401 || r.status === 403) return `HTTP ${r.status}: the endpoint rejected the key. Re-add it: agent-notify add-target ${target} <url>`;
  if (!hasKey && !noKey) return `HTTP ${r.status || '-'}: no key stored for "${target}"`;
  if (!r.status) return `could not reach the webhook (${r.error || 'network error'})`;
  return `HTTP ${r.status}`;
}

/** Redact a URL for display: keep scheme+host, hide path and query (they often contain secrets). */
export function redactUrl(u) {
  const m = /^(https?:\/\/[^/?#]+)/.exec(String(u));
  return m ? m[1] + (String(u).length > m[1].length ? '/…' : '') : '…';
}
