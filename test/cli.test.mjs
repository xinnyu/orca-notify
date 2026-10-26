import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/agent-notify');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'an-cli-'));
const run = (args, input = '') => spawnSync('bash', [CLI, ...args], { input, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
const P = f => path.join(home, '.orca-notify/pending', f);

test('help exits 0, unknown exits 2', () => {
  const h = run(['--help']); assert.equal(h.status, 0); assert.match(h.stdout, /add-target/); assert.doesNotMatch(h.stdout, /set -euo/);
  assert.equal(run(['bogus']).status, 2);
});
test('add-target writes pending + 600 key, re-add clears stale flags', () => {
  let r = run(['add-target', 'bot', 'https://h.example/x', '--format', 'slack', '--default'], 'sekret\n');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /agent-notify status/);
  const kf = path.join(home, '.orca-notify/keys/bot.key');
  assert.equal(fs.readFileSync(kf, 'utf8'), 'sekret'); assert.equal(fs.statSync(kf).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(P('bot.format')) && fs.existsSync(P('bot.default')) && fs.existsSync(P('bot.order')));
  r = run(['add-target', 'bot', 'https://h.example/y', '--no-key']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(P('bot.format')) && !fs.existsSync(P('bot.default'))); assert.ok(fs.existsSync(P('bot.nokey')));
  assert.ok(!fs.existsSync(kf), 'stale key removed when re-added without key');
});
test('format validation', () => {
  assert.equal(run(['add-target', 'x', 'https://h', '--format', 'teams']).status, 2);
  const r = run(['add-target', 'x', 'https://h', '--format']); assert.equal(r.status, 2); assert.match(r.stderr, /needs a value/);
});
test('name validation + remove-key reporting', () => {
  assert.equal(run(['add-target', '../evil', 'https://h']).status, 2);
  assert.equal(run(['remove-key', '../x']).status, 2);
  assert.match(run(['remove-key', 'nothing']).stdout, /No pending key/);
});
test('status redacts URLs and never prints keys', () => {
  fs.writeFileSync(path.join(home, '.orca-notify/config.json'), JSON.stringify({ targets: { s: { url: 'https://hooks.slack.com/services/T/B/SECRETPATH?token=abc' } } }));
  run(['add-target', 'k', 'https://h.example/z'], 'topsecretkey\n');
  const r = run(['status']); assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /SECRETPATH|token=abc|topsecretkey/); assert.match(r.stdout, /hooks\.slack\.com/);
});
test('remove-target queues removal', () => {
  const r = run(['remove-target', 'bot']); assert.equal(r.status, 0); assert.ok(fs.existsSync(P('bot.remove'))); assert.ok(!fs.existsSync(P('bot.url')));
});
