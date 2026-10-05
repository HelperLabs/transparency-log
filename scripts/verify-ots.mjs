// scripts/verify-ots.mjs
// Verifies every COMPLETE .ots in anchors/ and snapshots/ against its source
// file. Pending (not-yet-Bitcoin) proofs are skipped while young and fail once
// they have been pending longer than MAX_PENDING_MS (see lib/otsState.mjs).
import { readFileSync, existsSync } from "node:fs";
import { isComplete, verifyOts } from "./lib/ots.mjs";
import { findOtsFiles } from "./lib/otsUpgrade.mjs";
import { pendingVerdict } from "./lib/otsState.mjs";

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

let checked = 0, skipped = 0, failures = 0;
for (const otsPath of findOtsFiles(["anchors", "snapshots"])) {
  const filePath = otsPath.replace(/\.ots$/, "");
  if (!existsSync(filePath)) { console.error(`FAIL: ${otsPath}: source file ${filePath} missing`); failures++; continue; }
  const otsBytes = readFileSync(otsPath);
  if (!isComplete(otsBytes)) {
    // Pending is fine for a while, not forever: the anchor job upgrades proofs
    // as calendars confirm them, so one that stays pending is a failure.
    const verdict = pendingVerdict({ record: readRecord(filePath), now: Date.now() });
    if (!verdict.ok) { console.error(`FAIL: ${otsPath}: ${verdict.reason}`); failures++; continue; }
    console.log(`skip (pending ${(verdict.ageMs / 3600000).toFixed(1)}h): ${otsPath}`); skipped++; continue;
  }
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
