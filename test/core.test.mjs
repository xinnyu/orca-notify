import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, decide, buildPayload, postWithRetry } from '../plugin/core.mjs';

const cfg = normalizeConfig({
  defaultTarget: 'a', targets: { a: { url: 'http://a' }, b: { url: 'http://b' } },
  rules: [{ worktreeId: 'w1', target: 'b', label: 'W1' }, { paneKey: 'p9', target: 'a', label: 'P9' }, { worktreeId: 'mute', mute: true }],
});
test('fires on done to default target', () => assert.deepEqual(decide(cfg, { paneKey: 'p1', state: 'done' }, 'working').target, 'a'));
test('ignores working', () => assert.equal(decide(cfg, { paneKey: 'p1', state: 'working' }).fire, false));
test('dedupes same state', () => assert.equal(decide(cfg, { paneKey: 'p1', state: 'done' }, 'done').fire, false));
test('worktree rule routes', () => assert.equal(decide(cfg, { paneKey: 'p1', worktreeId: 'w1', state: 'blocked' }).target, 'b'));
test('pane rule beats worktree rule', () => assert.equal(decide(cfg, { paneKey: 'p9', worktreeId: 'w1', state: 'waiting' }).target, 'a'));
test('mute', () => assert.equal(decide(cfg, { paneKey: 'p1', worktreeId: 'mute', state: 'done' }).fire, false));
test('watch=listed', () => {
  const c = normalizeConfig({ ...cfg, watch: 'listed' });
  assert.equal(decide(c, { paneKey: 'zz', state: 'done' }).fire, false);
  assert.equal(decide(c, { paneKey: 'p9', state: 'done' }).fire, true);
});
test('payload fields', () => {
  const p = buildPayload({ paneKey: 'p9', worktreeId: 'w1', state: 'done', receivedAt: 0, mainAgent: { state: 'done', outcome: 'failure' } }, { label: 'L', paneKey: 'p9' }, 3);
  for (const k of ['time', 'label', 'watchKey', 'agentState', 'title', 'body', 'paneKey', 'worktreeId', 'seq', 'source']) assert.ok(k in p, k);
  assert.equal(p.label, 'L'); assert.equal(p.body, 'outcome: failure');
});
test('retry on 500 then ok, bearer header', async () => {
  const calls = []; let n = 0;
  const fetchImpl = async (u, o) => { calls.push(o.headers.Authorization); return { ok: ++n > 1, status: n > 1 ? 200 : 500 }; };
  const r = await postWithRetry('http://x', 'k', {}, { fetchImpl, sleep: async () => {} });
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.deepEqual(calls, ['Bearer k', 'Bearer k']);
});
test('no retry on 401', async () => {
  let n = 0; const r = await postWithRetry('http://x', null, {}, { fetchImpl: async () => (n++, { ok: false, status: 401 }), sleep: async () => {} });
  assert.equal(n, 1); assert.equal(r.ok, false);
});
