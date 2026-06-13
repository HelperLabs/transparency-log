// scripts/verify-ots.mjs
// Verifies every COMPLETE .ots in anchors/ and snapshots/ against its source
// file. Pending (not-yet-Bitcoin) proofs are skipped (not a failure).
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isComplete, verifyOts } from "./lib/ots.mjs";

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ots")) out.push(p);
  }
  return out;
}

let checked = 0, skipped = 0, failures = 0;
for (const otsPath of [...walk("anchors"), ...walk("snapshots")]) {
  const filePath = otsPath.replace(/\.ots$/, "");
  if (!existsSync(filePath)) { console.error(`FAIL: ${otsPath}: source file ${filePath} missing`); failures++; continue; }
  const otsBytes = readFileSync(otsPath);
  if (!isComplete(otsBytes)) { console.log(`skip (pending): ${otsPath}`); skipped++; continue; }
  try {
    const result = await verifyOts(otsBytes, readFileSync(filePath));
    // O.verify returns {} when no attestation verified; we only reach here for
    // proofs isComplete() already deemed Bitcoin-attested, so {} means the proof
    // failed to verify against the source file → fail.
    if (result && Object.keys(result).length > 0) { console.log(`OK: ${otsPath}`); checked++; }
    else { console.error(`FAIL: ${otsPath}: no attestation in verify result`); failures++; }
  } catch (err) {
    console.error(`FAIL: ${otsPath}: ${err?.message ?? err}`); failures++;
  }
}
console.log(`ots verify: ${checked} ok, ${skipped} pending, ${failures} failed`);
if (failures > 0) process.exit(1);
