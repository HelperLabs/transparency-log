// scripts/lib/anchorRun.mjs
// One run of the hourly anchor job, with the network pieces (root fetch,
// stamper, upgrader) passed in so it can run offline in tests. scripts/anchor.mjs
// is the thin CLI that supplies the real ones.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  LEGACY_SHARD,
  parseRoot,
  parseShards,
  parseCheckpoint,
  readLatestMap,
  decideAnchor,
  buildAnchorRecord,
  buildSealedAnchorRecord,
} from "./anchorDecision.mjs";
import { addPending } from "./otsState.mjs";
import { upgradeProofs } from "./otsUpgrade.mjs";

export const DEFAULT_LOG_BASE = "https://mypenny-transparency-log.mypenny.workers.dev";
export const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
export const LATEST = "anchors/latest.json";
export const PENDING = "anchors/pending.json";
// Signed snapshots are stamped by sign-snapshot.mjs, which registers nothing,
// so the upgrade loop finds their proofs by scanning instead.
export const SCAN_DIRS = ["snapshots"];

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };

/**
 * Upgrade proofs, fetch the shards/checkpoints (or legacy root on a 404),
 * decide, and (unless dryRun) stamp and record.
 *
 * With `dryRun` the run reads the log and the repo, then prints what it
 * would do. It stamps nothing, contacts no OTS calendar, and writes no file.
 *
 * Returns { action } where action is one of: "would-anchor", "anchored",
 * "skipped", "root-fetch-failed", "stamp-failed".
 */
export async function runAnchor({
  logBase, rootUrl, outDir, scanDirs,
  fetchFn = fetch, upgrade, stamp, isComplete,
  now = Date.now(), heartbeatMs = HEARTBEAT_MS, dryRun = false, log = console.log,
}) {
  const anchorsDir = outDir ? outDir.replace(/\/+$/, "") : "anchors";
  const latestPath = `${anchorsDir}/latest.json`;
  const pendingPath = `${anchorsDir}/pending.json`;
  const effectiveScanDirs = scanDirs ?? (outDir ? [] : SCAN_DIRS);

  if (dryRun) log("dry run: nothing will be stamped, written, or committed");

  // 1. Upgrade incomplete proofs: the tracked anchors plus every snapshot proof.
  const upgraded = await upgradeProofs({
    pending: readJson(pendingPath, []), scanDirs: effectiveScanDirs, upgrade, isComplete, dryRun, log,
  });
  let pending = upgraded.pending;
  if (dryRun) {
    log(`would upgrade ${upgraded.wouldUpgrade.length} incomplete proof(s)${upgraded.wouldUpgrade.length ? `: ${upgraded.wouldUpgrade.join(", ")}` : ""}`);
  }
  const save = () => { if (!dryRun) writeJson(pendingPath, pending); };

  // Helper for anchoring one open root (used by both legacy-root fallback and
  // the shard-aware open shard path).
  const anchorOpenRoot = async ({ shard, root, source, includeShardInRecord, anchoredSealed = [], wouldAnchorSealed = [] }) => {
    const latestMap = readLatestMap(readJson(latestPath, null));
    const latest = latestMap.byShard[shard] ?? null;
    const decision = decideAnchor({ root, latest, now, heartbeatMs });
    log(`decision: shard=${shard} anchor=${decision.anchor} (${decision.reason}) seqno=${root.seqno}`);
    if (!decision.anchor) {
      save();
      if (dryRun && wouldAnchorSealed.length > 0) return { action: "would-anchor", wouldAnchorSealed };
      if (anchoredSealed.length > 0) return { action: "anchored", anchoredSealed };
      return { action: "skipped" };
    }

    const { record, path } = buildAnchorRecord({
      root,
      now,
      source,
      shard: includeShardInRecord ? shard : undefined,
      anchorsDir,
    });
    const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    if (dryRun) {
      log(`would anchor ${path}`);
      log(`record that would be stamped:\n${recordBytes.toString("utf8").trimEnd()}`);
      log(`would stamp it at the public OpenTimestamps calendars, then write ${path}, ${path}.ots, ${pendingPath} and ${latestPath}`);
      return { action: "would-anchor", path, record, ...(wouldAnchorSealed.length ? { wouldAnchorSealed } : {}) };
    }

    // Stamp first, then write record + proof + state together. Stamping before
    // any write means an OTS-calendar outage is a soft skip (no failed CI, no
    // orphaned record) — the next run retries with a fresh anchor.
    let ots;
    try {
      ots = await stamp(recordBytes);
    } catch (err) {
      log(`stamp failed (${err?.message ?? err}); skipping anchor this run`);
      save();
      return { action: anchoredSealed.length > 0 ? "anchored" : "stamp-failed", ...(anchoredSealed.length ? { anchoredSealed } : {}) };
    }
    writeJson(path, record);
    writeFileSync(`${path}.ots`, ots);
    pending = addPending(pending, `${path}.ots`);
    writeJson(pendingPath, pending);
    const nextLatest = {
      byShard: {
        ...latestMap.byShard,
        [shard]: { seqno: root.seqno, rootHash: root.rootHash, capturedAt: record.capturedAt, file: path },
      },
    };
    writeJson(latestPath, nextLatest);
    log(`anchored ${path}`);
    return { action: "anchored", path, record, ...(anchoredSealed.length ? { anchoredSealed } : {}) };
  };

  // Legacy single-root mode (explicit rootUrl without logBase, or /api/log/shards 404).
  const runLegacyRoot = async (url) => {
    const res = await fetchFn(url);
    if (!res.ok) { log(`root fetch ${res.status}; skipping anchor this run`); save(); return { action: "root-fetch-failed" }; }
    const root = parseRoot(await res.text());
    return anchorOpenRoot({ shard: LEGACY_SHARD, root, source: url, includeShardInRecord: false });
  };

  if (!logBase) {
    return runLegacyRoot(rootUrl);
  }

  // 2. Shard-aware mode: inspect /api/log/shards.
  const base = logBase.replace(/\/+$/, "");
  const shardsRes = await fetchFn(`${base}/api/log/shards`);
  if (shardsRes.status === 404) {
    log("/api/log/shards returned 404 (pre-Phase-2 worker); falling back to /api/log/root");
    return runLegacyRoot(`${base}/api/log/root`);
  }
  if (!shardsRes.ok) {
    log(`shards fetch ${shardsRes.status}; skipping anchor this run`);
    save();
    return { action: "root-fetch-failed" };
  }
  const shards = parseShards(await shardsRes.text());

  // 3. Anchor each sealed shard's final checkpoint exactly once.
  const anchoredSealed = [];
  const wouldAnchorSealed = [];
  for (const s of shards) {
    if (s.state !== "sealed") continue;
    const targetPath = `${anchorsDir}/sealed/${s.shard}.json`;
    if (existsSync(targetPath)) {
      log(`sealed shard ${s.shard} already anchored at ${targetPath}; skipping`);
      continue;
    }
    const checkpointUrl = `${base}/api/log/${s.shard}/checkpoint`;
    const cpRes = await fetchFn(checkpointUrl);
    if (!cpRes.ok) {
      log(`sealed checkpoint fetch for ${s.shard} returned ${cpRes.status}; skipping`);
      continue;
    }
    const cp = parseCheckpoint(await cpRes.text(), s.shard);
    if (!cp.sealed) {
      log(`checkpoint for ${s.shard} reported sealed=false despite /shards sealed; skipping`);
      continue;
    }
    const { record, path } = buildSealedAnchorRecord({ checkpoint: cp, now, source: checkpointUrl, anchorsDir });
    const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    if (dryRun) {
      log(`would anchor sealed shard ${s.shard} at ${path}`);
      wouldAnchorSealed.push(path);
      continue;
    }
    let ots;
    try {
      ots = await stamp(recordBytes);
    } catch (err) {
      log(`stamp failed for sealed shard ${s.shard} (${err?.message ?? err}); skipping`);
      continue;
    }
    writeJson(path, record);
    writeFileSync(`${path}.ots`, ots);
    pending = addPending(pending, `${path}.ots`);
    writeJson(pendingPath, pending);
    anchoredSealed.push(path);
    log(`anchored sealed shard ${s.shard} at ${path}`);
  }

  // 4. Anchor the single open shard using its live checkpoint.
  const openShards = shards.filter((s) => s.state === "open");
  if (openShards.length > 1) {
    throw new Error(`worker reported ${openShards.length} open shards (${openShards.map((s) => s.shard).join(", ")})`);
  }
  if (openShards.length === 0) {
    log("no open shard reported; skipping live anchor");
    save();
    if (dryRun && wouldAnchorSealed.length > 0) return { action: "would-anchor", wouldAnchorSealed };
    return { action: anchoredSealed.length > 0 ? "anchored" : "skipped", ...(anchoredSealed.length ? { anchoredSealed } : {}) };
  }

  const openShard = openShards[0].shard;
  const checkpointUrl = `${base}/api/log/${openShard}/checkpoint`;
  const cpRes = await fetchFn(checkpointUrl);
  if (!cpRes.ok) {
    log(`checkpoint fetch for open shard ${openShard} returned ${cpRes.status}; skipping live anchor`);
    save();
    return { action: anchoredSealed.length > 0 ? "anchored" : "root-fetch-failed", ...(anchoredSealed.length ? { anchoredSealed } : {}) };
  }
  const cp = parseCheckpoint(await cpRes.text(), openShard);
  if (cp.sealed) {
    throw new Error(`open shard ${openShard} checkpoint reported sealed=true`);
  }
  const root = { seqno: cp.size, rootHash: cp.size === 0 ? "" : cp.rootHash };
  return anchorOpenRoot({
    shard: openShard,
    root,
    source: checkpointUrl,
    includeShardInRecord: true,
    anchoredSealed,
    wouldAnchorSealed,
  });
}
