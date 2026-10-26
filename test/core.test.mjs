import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, decide, buildPayload, formatBody, postWithRetry, mergePending, splitWorktreeId, failureHint, redactUrl } from '../plugin/core.mjs';

const cfg = normalizeConfig({
  defaultTarget: 'a', targets: { a: { url: 'http://a' }, b: { url: 'http://b' }, c: { url: 'http://c' } },
  rules: [{ worktreeId: 'R1::/w1', target: 'b', label: 'W1' }, { paneKey: 'p9', target: 'a', label: 'P9' },
    { worktreeId: 'R1::/mute', mute: true }, { repoId: 'R2', target: 'c' }, { pathPrefix: '/proj/x', target: 'b' }],
});
const W = { state: 'working', armed: true };
// run a sequence of states through decide() for one pane, returning which ones fired
function run(states, ev = {}) {
  let pane; const fired = [];
  for (const s of states) { const d = decide(cfg, { paneKey: 'p1', ...ev, state: s }, pane); pane = d.pane; if (d.fire) fired.push(s); }
  return fired;
}
test('fresh session idle done does not fire', () => assert.deepEqual(run(['done']), []));
test('one task = one done', () => assert.deepEqual(run(['done', 'working', 'done', 'done']), ['done']));
test('two tasks = two dones', () => assert.deepEqual(run(['working', 'done', 'working', 'done']), ['done', 'done']));
test('waiting needs working first, then re-arms', () => assert.deepEqual(run(['waiting', 'working', 'waiting', 'working', 'done']), ['waiting', 'done']));
test('blocked fires immediately, once', () => assert.deepEqual(run(['blocked', 'blocked', 'working', 'done']), ['blocked', 'done']));
test('done -> done after restart without working does not fire', () => assert.deepEqual(run(['working', 'done', 'done']), ['done']));
test('default target', () => assert.equal(decide(cfg, { paneKey: 'p1', state: 'done' }, W).target, 'a'));
test('worktree rule', () => assert.equal(decide(cfg, { paneKey: 'p1', worktreeId: 'R1::/w1', state: 'done' }, W).target, 'b'));
test('pane beats worktree', () => assert.equal(decide(cfg, { paneKey: 'p9', worktreeId: 'R1::/w1', state: 'done' }, W).target, 'a'));
test('repoId rule', () => assert.equal(decide(cfg, { paneKey: 'p1', worktreeId: 'R2::/any/where', state: 'done' }, W).target, 'c'));
test('pathPrefix rule', () => {
  assert.equal(decide(cfg, { paneKey: 'p1', worktreeId: 'R3::/proj/x/.claude/wt', state: 'done' }, W).target, 'b');
  assert.equal(decide(cfg, { paneKey: 'p1', worktreeId: 'R3::/proj/xyz', state: 'done' }, W).target, 'a');
});
test('mute', () => assert.equal(decide(cfg, { paneKey: 'p1', worktreeId: 'R1::/mute', state: 'done' }, W).fire, false));
test('watch=listed', () => {
  const c = normalizeConfig({ ...cfg, targets: cfg.targets, watch: 'listed' });
  assert.equal(decide(c, { paneKey: 'zz', state: 'done' }, W).fire, false);
  assert.equal(decide(c, { paneKey: 'p9', state: 'done' }, W).fire, true);
});
test('minimal config: just url', () => {
  const c = normalizeConfig({ url: 'https://x' });
  assert.equal(c.defaultTarget, 'default'); assert.equal(decide(c, { paneKey: 'p', state: 'done' }, W).target, 'default');
});
test('single target becomes default', () => assert.equal(normalizeConfig({ targets: { only: { url: 'https://x' } } }).defaultTarget, 'only'));
test('splitWorktreeId', () => assert.deepEqual(splitWorktreeId('abc::/a/b'), { repoId: 'abc', path: '/a/b' }));
test('payload fields + label from path', () => {
  const p = buildPayload({ paneKey: 'p9', worktreeId: 'R::/u/proj/wt1', state: 'done', receivedAt: 0, mainAgent: { state: 'done', outcome: 'failure' } }, null, 3);
  for (const k of ['time', 'label', 'watchKey', 'agentState', 'title', 'body', 'paneKey', 'worktreeId', 'seq', 'source']) assert.ok(k in p, k);
  assert.equal(p.label, 'proj/wt1'); assert.equal(p.body, 'outcome: failure');
});
test('formats', () => {
  const p = buildPayload({ paneKey: 'p', state: 'done' }, { label: 'L' }, 1);
  assert.equal(formatBody('slack', p).text, 'Agent done: L'); assert.equal(formatBody('discord', p).content, 'Agent done: L');
  assert.equal(formatBody('generic', p), p);
});
test('mergePending: add order decides default, not name', () => {
  const { config: c } = mergePending({ url: '', targets: {} }, [
    { name: 'zeta', url: 'https://h/z', order: 1 }, { name: 'alpha', url: 'https://h/a', order: 2 },
    { name: 'bad name', url: 'https://h', order: 3 }, { name: 'ftp', url: 'ftp://x', order: 4 }]);
  assert.deepEqual(Object.keys(c.targets).sort(), ['alpha', 'zeta']); assert.equal(c.defaultTarget, 'zeta');
  const { config: d } = mergePending(c, [{ name: 'two', url: 'https://h/2', format: 'slack' }]);
  assert.equal(d.defaultTarget, 'zeta'); assert.equal(d.targets.two.format, 'slack');
  assert.equal(mergePending(d, [{ name: 'three', url: 'https://h/3', makeDefault: true }]).config.defaultTarget, 'three');
  assert.equal(mergePending(d, [{ name: 'x', url: 'https://h/x', format: 'bogus' }]).config.targets.x.format, undefined);
});
test('mergePending: remove target clears default', () => {
  const { config, removed } = mergePending({ defaultTarget: 'a', targets: { a: { url: 'https://a' }, b: { url: 'https://b' } } }, [{ name: 'a', remove: true }]);
  assert.deepEqual(removed, ['a']); assert.deepEqual(Object.keys(config.targets), ['b']); assert.equal(config.defaultTarget, undefined);
  assert.equal(normalizeConfig(config).defaultTarget, 'b');
});
test('failureHint', () => {
  assert.match(failureHint({ status: 401 }, { hasKey: true, target: 't' }), /add-target t/);
  assert.match(failureHint({ status: 0, error: 'timeout' }, { hasKey: true, target: 't' }), /could not reach/);
  assert.match(failureHint({ status: 500 }, { hasKey: false, noKey: false, target: 't' }), /no key stored/);
});
test('redactUrl', () => {
  assert.equal(redactUrl('https://hooks.slack.com/services/T/B/secret?token=x'), 'https://hooks.slack.com/…');
  assert.equal(redactUrl('https://example.com'), 'https://example.com');
});
test('default timeout is short', () => assert.equal(normalizeConfig({}).timeoutMs, 5000));
test('retry on 500 then ok, bearer header', async () => {
  const calls = []; let n = 0;
  const r = await postWithRetry('http://x', 'k', {}, { fetchImpl: async (u, o) => { calls.push(o.headers.Authorization); return { ok: ++n > 1, status: n > 1 ? 200 : 500 }; }, sleep: async () => {} });
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.deepEqual(calls, ['Bearer k', 'Bearer k']);
});
test('no retry on 401', async () => {
  let n = 0; const r = await postWithRetry('http://x', null, {}, { fetchImpl: async () => (n++, { ok: false, status: 401 }), sleep: async () => {} });
  assert.equal(n, 1); assert.equal(r.ok, false);
});
