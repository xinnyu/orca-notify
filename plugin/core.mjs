// Pure logic for orca-notify (no Orca host dependencies) so it can be unit-tested.

export const DEFAULT_STATES = ['done', 'blocked', 'waiting'];

/** Normalize a user config object, filling defaults. */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    states: Array.isArray(c.states) && c.states.length ? c.states.map(String) : DEFAULT_STATES,
    watch: c.watch === 'listed' ? 'listed' : 'all',
    defaultTarget: typeof c.defaultTarget === 'string' ? c.defaultTarget : null,
    targets: c.targets && typeof c.targets === 'object' ? c.targets : {},
    rules: Array.isArray(c.rules) ? c.rules.filter(r => r && typeof r === 'object') : [],
    retries: Number.isInteger(c.retries) ? Math.max(0, Math.min(c.retries, 5)) : 2,
    timeoutMs: Number.isInteger(c.timeoutMs) ? c.timeoutMs : 10000,
  };
}

/** First rule matching the pane wins over a worktree rule. */
export function findRule(cfg, ev) {
  return cfg.rules.find(r => r.paneKey && r.paneKey === ev.paneKey)
    || cfg.rules.find(r => r.worktreeId && r.worktreeId === ev.worktreeId)
    || null;
}

/** Decide whether an agent.status.changed payload should fire, and to which target. */
export function decide(cfg, ev, prevState) {
  if (!ev || typeof ev.paneKey !== 'string') return { fire: false, why: 'no paneKey' };
  const state = ev.state;
  if (!cfg.states.includes(state)) return { fire: false, why: `state ${state} not watched` };
  if (prevState === state) return { fire: false, why: 'unchanged state (dedupe)' };
  const rule = findRule(cfg, ev);
  if (rule && rule.mute) return { fire: false, why: 'muted by rule' };
  if (cfg.watch === 'listed' && !rule) return { fire: false, why: 'not in rules (watch=listed)' };
  const target = (rule && rule.target) || cfg.defaultTarget;
  if (!target || !cfg.targets[target]) return { fire: false, why: `no target (${target || 'none'})` };
  return { fire: true, target, rule };
}

/** Webhook body: same field names as the legacy listener where available. */
export function buildPayload(ev, rule, seq) {
  const label = (rule && rule.label) || ev.worktreeId || ev.paneKey;
  return {
    time: new Date(ev.receivedAt || Date.now()).toISOString(),
    label,
    watchKey: rule ? (rule.paneKey || rule.worktreeId) : null,
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

/** POST JSON with Bearer auth and small exponential-backoff retry. Returns {ok,status,attempts}. */
export async function postWithRetry(url, key, body, { retries = 2, timeoutMs = 10000, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
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
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return last; // don't retry client errors
    } catch (e) { last = { ok: false, status: 0, attempts: i + 1, error: String(e && e.message || e) }; }
    finally { clearTimeout(t); }
  }
  return last;
}
