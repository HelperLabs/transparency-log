// scripts/lib/otsUpgrade.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { removeCompleted } from "./otsState.mjs";

/** Every .ots file under the given directories (recursive), sorted. Missing dirs are empty. */
export function findOtsFiles(dirs) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ots")) out.push(p);
    }
  };
  dirs.forEach(walk);
  return out.sort();
}

/**
 * Upgrade every incomplete proof we are responsible for: the tracked `pending`
 * list (anchors) plus whatever a scan of `scanDirs` finds (signed snapshots,
 * which nothing registers). Proofs that are already complete are skipped
 * without contacting a calendar. One broken proof is reported and does not
 * stop the rest.
 *
 * Returns { pending, completed, failed }:
 *   pending   - the tracked list with completed or vanished entries removed
 *   completed - proofs that became complete during this call
 *   failed    - proofs that threw while reading or upgrading
 */
export async function upgradeProofs({ pending, scanDirs, upgrade, isComplete, log = () => {} }) {
  const candidates = [...new Set([...pending, ...findOtsFiles(scanDirs)])];
  const done = new Set();       // stop tracking: completed or vanished
  const completed = [];
  const failed = [];
  for (const path of candidates) {
    if (!existsSync(path)) { done.add(path); continue; } // record gone -> stop tracking
    try {
      let bytes = readFileSync(path);
      if (isComplete(bytes)) { done.add(path); continue; }
      const result = await upgrade(bytes);
      if (result.changed) writeFileSync(path, result.bytes);
      if (isComplete(result.bytes)) { done.add(path); completed.push(path); log(`upgraded complete: ${path}`); }
    } catch (err) {
      failed.push(path);
      log(`upgrade failed for ${path}: ${err?.message ?? err}`);
    }
  }
  return { pending: removeCompleted(pending, done), completed, failed };
}
