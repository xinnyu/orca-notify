import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFileName, loadWatchDir, parseEntry } from '../plugin/watch.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(ROOT, 'bin/agent-notify');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'an-watch-'));
process.env.HOME = home; // main.mjs resolves ~/.orca-notify at import time
const D = path.join(home, '.orca-notify'), W = path.join(D, 'watch');
const run = (args, input = '') => spawnSync('bash', [CLI, ...args], { input, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
const files = () => (fs.existsSync(W) ? fs.readdirSync(W).filter(f => f.endsWith('.json')) : []);
const settle = ms => new Promise(r => setTimeout(r, ms));

test('helper file name == plugin file name (deterministic, safe)', () => {
  for (const k of ['t1:l2', 'a/b:c d', 'x'.repeat(300), 'ünï"\\']) {
    fs.rmSync(W, { recursive: true, force: true });
    assert.equal(run(['watch', k]).status, 0);
    assert.deepEqual(files(), [watchFileName('paneKey', k)]);
    assert.ok(!files()[0].includes('/') && !files()[0].includes(':'));
    assert.equal(parseEntry(fs.readFileSync(path.join(W, files()[0]), 'utf8')).paneKey, k);
  }
});

test('50 parallel watch processes all survive; re-watch is idempotent', async () => {
  fs.rmSync(W, { recursive: true, force: true });
  const one = args => new Promise(r => spawn('bash', [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home }, stdio: 'ignore' }).on('exit', r));
  const codes = await Promise.all([...Array(50)].map((_, i) => one(['watch', `tab${i}:leaf${i}`, '--label', `L${i}`])));
  assert.ok(codes.every(c => c === 0));
  const again = await Promise.all([...Array(20)].map(() => one(['watch', 'tab0:leaf0', '--label', 'L0'])));
  assert.ok(again.every(c => c === 0));
  assert.equal(files().length, 50);
  assert.equal(loadWatchDir(W).rules.length, 50);
  assert.equal(fs.readdirSync(W).filter(f => f.startsWith('.')).length, 0, 'no tmp leftovers');
  assert.equal(fs.statSync(path.join(W, files()[0])).mode & 0o777, 0o600);
});

test('unwatch, list, status count, prune of expired', async () => {
  fs.rmSync(W, { recursive: true, force: true });
  run(['watch', 'p:1', '--label', 'One']); run(['watch', '--worktree', 'R::/w']); run(['watch', 'p:short', '--ttl', '1s']);
  assert.match(run(['list']).stdout, /paneKey=p:1 +label="One".*age=\d+s expires_in=(23h|1d0h)/);
  assert.match(run(['status']).stdout, /watches: 3/);
  assert.match(run(['unwatch', 'p:1']).stdout, /Unwatched/);
  assert.match(run(['unwatch', '--worktree', 'R::/w']).stdout, /Unwatched/);
  await settle(1100);
  assert.match(run(['prune']).stdout, /Pruned 1/);
  assert.deepEqual(files(), []);
  assert.equal(run(['watch', 'p', '--ttl', 'soon']).status, 2);
});

test('plugin loader deletes expired entries and stale tmp/garbage, keeps fresh tmp', () => {
  fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(W, { recursive: true });
  run(['watch', 'keep']);
  const exp = path.join(W, watchFileName('paneKey', 'old')); fs.writeFileSync(exp, '{"paneKey":"old"}'); fs.utimesSync(exp, 1, Date.now() / 1000 - 5);
  fs.writeFileSync(path.join(W, '.tmp.x.1'), '{'); fs.writeFileSync(path.join(W, '.tmp.x.2'), '{');
  const old = Date.now() + 120_000; // pretend "now" is 2 minutes later for the tmp files
  const r1 = loadWatchDir(W);
  assert.deepEqual(r1.rules.map(r => r.paneKey), ['keep']); assert.deepEqual(r1.removed, [path.basename(exp)]);
  assert.equal(fs.readdirSync(W).filter(f => f.startsWith('.tmp')).length, 2, 'fresh tmp kept');
  const r2 = loadWatchDir(W, old);
  assert.equal(fs.readdirSync(W).filter(f => f.startsWith('.tmp')).length, 0, 'stale tmp removed');
  assert.ok(r2.removed.length >= 2);
});

// ---- the real plugin worker with a fake Orca host ----
async function startPlugin(config) {
  fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
  const got = [];
  const srv = http.createServer((q, s) => { let b = ''; q.on('data', d => (b += d)); q.on('end', () => { got.push({ path: q.url, body: JSON.parse(b) }); s.statusCode = 204; s.end(); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cfg = JSON.parse(JSON.stringify(config).replaceAll('BASE', base));
  fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify(cfg));
  const storage = {}, handlers = {}, commands = {};
  const host = { 'storage.get': p => ({ value: storage[p.key] ?? null }), 'storage.set': p => { storage[p.key] = structuredClone(p.value); },
    'secrets.get': () => ({ value: null }), 'secrets.set': () => {}, 'secrets.delete': () => {}, 'notifications.show': () => {} };
  const ctx = { host: { call: async (m, p) => host[m](p) }, log: () => {}, events: { on: (e, h) => (handlers[e] = h) }, commands: { register: (id, f) => (commands[id] = f) } };
  const mod = await import('../plugin/main.mjs?' + Math.random());
  await mod.default(ctx);
  const emit = async (state, paneKey = 'p:1', worktreeId = 'R::/w') => { await handlers['agent.status.changed']({ paneKey, worktreeId, state, receivedAt: Date.now() }); await settle(150); };
  srv.unref();
  return { got, emit, handlers, commands, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const listed = { watch: 'listed', defaultTarget: 'bot', targets: { bot: { url: 'BASE/bot', noKey: true }, side: { url: 'BASE/side', noKey: true } } };

test('plugin: watch-dir entry notifies, unlisted pane does not, unwatch stops it', async () => {
  const p = await startPlugin(listed);
  run(['watch', 'p:1', '--label', 'Avatar', '--target', 'side']);
  await p.emit('working'); await p.emit('done');
  await p.emit('working', 'p:2'); await p.emit('done', 'p:2');
  assert.deepEqual(p.got.map(g => [g.path, g.body.label]), [['/side', 'Avatar']]);
  run(['unwatch', 'p:1']); await p.emit('working'); await p.emit('done');
  assert.equal(p.got.length, 1); p.close();
});

test('plugin: config rules still work (back compat) alongside watch dir', async () => {
  const p = await startPlugin({ ...listed, rules: [{ paneKey: 'p:cfg', label: 'FromConfig' }] });
  run(['watch', 'p:1']);
  await p.emit('working', 'p:cfg'); await p.emit('done', 'p:cfg'); await p.emit('working'); await p.emit('done');
  assert.deepEqual(p.got.map(g => g.body.label), ['FromConfig', 'w']); p.close();
});

test('plugin: working refreshes expiry; expired entry is deleted and stops notifying', async () => {
  const p = await startPlugin(listed);
  run(['watch', 'p:1', '--ttl', '2s']);
  const f = path.join(W, watchFileName('paneKey', 'p:1'));
  await settle(1200); const before = fs.statSync(f).mtimeMs;
  await p.emit('working');
  assert.ok(fs.statSync(f).mtimeMs > before + 1000, 'expiry pushed forward');
  await settle(2100); await p.emit('done');
  assert.equal(fs.existsSync(f), false, 'expired file deleted'); assert.equal(p.got.length, 0); p.close();
});

test('plugin: --once deletes the entry after the first done (not after blocked)', async () => {
  const p = await startPlugin(listed);
  run(['watch', 'p:1', '--once']);
  await p.emit('blocked'); assert.equal(files().length, 1);
  await p.emit('working'); await p.emit('done');
  assert.deepEqual(files(), []);
  await p.emit('working'); await p.emit('done');
  assert.deepEqual(p.got.map(g => g.body.agentState), ['blocked', 'done']); p.close();
});

test('plugin: worktree.removed drops watches of that worktree and its panes', async () => {
  const p = await startPlugin(listed);
  run(['watch', 'p:1']); run(['watch', 'p:other']); run(['watch', '--worktree', 'R::/w']); run(['watch', '--path', '/w']);
  await p.emit('working', 'p:1', 'R::/w'); await p.emit('working', 'p:other', 'R::/x');
  await p.handlers['worktree.removed']({ worktreeId: 'R::/w', path: '/w' }); await settle(100);
  assert.deepEqual(loadWatchDir(W).rules.map(r => r.paneKey), ['p:other']);
  const s = await p.commands.reload(); assert.equal(s.watches, 1); p.close();
});

test('migrate-rules moves paneKey rules into the watch dir and keeps other rules', () => {
  fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify({ watch: 'listed', url: 'https://x', rules: [{ paneKey: 'a:1', label: 'A', target: 'bot' }, { paneKey: 'b:2' }, { repoId: 'R' }] }));
  const r = run(['migrate-rules']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Migrated 2/);
  const c = JSON.parse(fs.readFileSync(path.join(D, 'config.json'), 'utf8'));
  assert.deepEqual(c.rules, [{ repoId: 'R' }]); assert.equal(c.url, 'https://x');
  assert.deepEqual(loadWatchDir(W).rules.map(r => [r.paneKey, r.label, r.target]).sort(), [['a:1', 'A', 'bot'], ['b:2', undefined, undefined]]);
  assert.match(run(['migrate-rules']).stdout, /Migrated 0/);
});
