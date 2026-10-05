// scripts/lib/anchorRun.mjs
// One run of the hourly anchor job, with the network pieces (root fetch,
// stamper, upgrader) passed in so it can run offline in tests. scripts/anchor.mjs
// is the thin CLI that supplies the real ones.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseRoot, decideAnchor, buildAnchorRecord } from "./anchorDecision.mjs";
import { addPending } from "./otsState.mjs";
import { upgradeProofs } from "./otsUpgrade.mjs";

export const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
export const LATEST = "anchors/latest.json";
export const PENDING = "anchors/pending.json";
// Signed snapshots are stamped by sign-snapshot.mjs, which registers nothing,
// so the upgrade loop finds their proofs by scanning instead.
export const SCAN_DIRS = ["snapshots"];

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };

/**
 * Upgrade proofs, fetch the root, decide, and (unless dryRun) stamp and record.
 *
 * With `dryRun` the run reads the log root and the repo, then prints what it
 * would do. It stamps nothing, contacts no OTS calendar, and writes no file.
 *
 * Returns { action } where action is one of: "would-anchor", "anchored",
 * "skipped", "root-fetch-failed", "stamp-failed".
 */
export async function runAnchor({
  rootUrl, fetchFn = fetch, upgrade, stamp, isComplete,
  now = Date.now(), heartbeatMs = HEARTBEAT_MS, dryRun = false, log = console.log,
}) {
  if (dryRun) log("dry run: nothing will be stamped, written, or committed");

  // 1. Upgrade incomplete proofs: the tracked anchors plus every snapshot proof.
  const upgraded = await upgradeProofs({
    pending: readJson(PENDING, []), scanDirs: SCAN_DIRS, upgrade, isComplete, dryRun, log,
  });
  let pending = upgraded.pending;
  if (dryRun) {
    log(`would upgrade ${upgraded.wouldUpgrade.length} incomplete proof(s)${upgraded.wouldUpgrade.length ? `: ${upgraded.wouldUpgrade.join(", ")}` : ""}`);
  }
  const save = () => { if (!dryRun) writeJson(PENDING, pending); };

  // 2. Fetch current root.
  const res = await fetchFn(rootUrl);
  if (!res.ok) { log(`root fetch ${res.status}; skipping anchor this run`); save(); return { action: "root-fetch-failed" }; }
  const root = parseRoot(await res.text());

  // 3. Decide.
  const latest = readJson(LATEST, null);
  const decision = decideAnchor({ root, latest, now, heartbeatMs });
  log(`decision: anchor=${decision.anchor} (${decision.reason}) seqno=${root.seqno}`);
  if (!decision.anchor) { save(); return { action: "skipped" }; }

  const { record, path } = buildAnchorRecord({ root, now, source: rootUrl });
  const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
  if (dryRun) {
    log(`would anchor ${path}`);
    log(`record that would be stamped:\n${recordBytes.toString("utf8").trimEnd()}`);
    log(`would stamp it at the public OpenTimestamps calendars, then write ${path}, ${path}.ots, ${PENDING} and ${LATEST}`);
    return { action: "would-anchor", path, record };
  }

  // 4. Stamp first, then write record + proof + state together. Stamping before
  // any write means an OTS-calendar outage is a soft skip (no failed CI, no
  // orphaned record) — the next run retries with a fresh anchor.
  let ots;
  try {
    ots = await stamp(recordBytes);
  } catch (err) {
    log(`stamp failed (${err?.message ?? err}); skipping anchor this run`);
    save();
    return { action: "stamp-failed" };
  }
  writeJson(path, record);
  writeFileSync(`${path}.ots`, ots);
  pending = addPending(pending, `${path}.ots`);
  writeJson(PENDING, pending);
  writeJson(LATEST, { seqno: root.seqno, rootHash: root.rootHash, capturedAt: record.capturedAt, file: path });
  log(`anchored ${path}`);
  return { action: "anchored", path, record };
}
