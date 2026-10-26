// Watch registry: ~/.orca-notify/watch/<kind>-<encoded key>.json, one file per registration.
// Writers (bin/agent-notify) create files atomically (tmp + rename), so concurrent registrations
// never lose each other. The file's mtime IS its expiry time (set into the future on write and
// pushed forward when the pane reports `working`); expired files are deleted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const KINDS = { paneKey: 'pane', worktreeId: 'worktree', pathPrefix: 'path', repoId: 'repo' };
export const TMP_MAX_AGE_MS = 60_000;
export const DEFAULT_TTL_HOURS = 24;

/** Deterministic, filesystem-safe file name for a registration key (same algorithm as bin/agent-notify). */
export function watchFileName(kind, key) {
  const enc = Buffer.from(String(key), 'utf8').toString('hex');
  return `${KINDS[kind] || kind}-${enc.length > 200 ? 'h' + sha256hex(key) : enc}.json`;
}
function sha256hex(s) { return createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/** Parse one entry. Returns a rule object ({paneKey|worktreeId|pathPrefix|repoId, target?, label?, once?, ttlSec, file}) or null. */
export function parseEntry(text) {
  let e; try { e = JSON.parse(text); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  const kind = Object.keys(KINDS).find(k => typeof e[k] === 'string' && e[k]);
  if (!kind) return null;
  const r = { [kind]: e[kind] };
  if (typeof e.target === 'string' && e.target) r.target = e.target;
  if (typeof e.label === 'string' && e.label) r.label = e.label;
  if (e.once === true) r.once = true;
  if (e.mute === true) r.mute = true;
  r.ttlSec = Number.isFinite(e.ttlSec) && e.ttlSec > 0 ? e.ttlSec : DEFAULT_TTL_HOURS * 3600;
  if (Number.isFinite(e.created)) r.created = e.created;
  return r;
}

/**
 * Read the watch dir, deleting expired entries, unparsable entries older than a minute and
 * leftover .tmp files older than a minute. Returns {rules, removed:[file names]}.
 */
export function loadWatchDir(dir, now = Date.now()) {
  const rules = [], removed = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { rules, removed }; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const rm = () => { try { fs.unlinkSync(p); removed.push(n); } catch {} };
    if (n.startsWith('.') || !n.endsWith('.json')) { if (now - st.ctimeMs > TMP_MAX_AGE_MS && n.includes('.tmp')) rm(); continue; }
    if (st.mtimeMs <= now) { rm(); continue; } // expired
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const r = parseEntry(text);
    if (!r) { if (now - st.ctimeMs > TMP_MAX_AGE_MS) rm(); continue; }
    r.file = n; r.expiresAt = st.mtimeMs;
    rules.push(r);
  }
  return { rules, removed };
}

/** Push an entry's expiry to now + its TTL (only if the file still exists; never resurrects). */
export function refreshEntry(dir, rule, now = Date.now()) {
  const p = path.join(dir, rule.file);
  const exp = (now + rule.ttlSec * 1000) / 1000;
  try { fs.utimesSync(p, exp, exp); rule.expiresAt = exp * 1000; return true; } catch { return false; }
}

export function removeEntry(dir, file) { try { fs.unlinkSync(path.join(dir, file)); return true; } catch { return false; } }
