// scripts/anchor.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseRoot, decideAnchor, buildAnchorRecord } from "./lib/anchorDecision.mjs";
import { addPending, removeCompleted } from "./lib/otsState.mjs";
import { stampBytes, upgradeOts, isComplete } from "./lib/ots.mjs";

const ROOT_URL = process.env.ROOT_URL
  ?? "https://mypenny-transparency-log.mypenny.workers.dev/api/log/root";
const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const LATEST = "anchors/latest.json";
const PENDING = "anchors/pending.json";

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };

async function main() {
  // 1. Upgrade pending proofs; drop any that completed.
  let pending = readJson(PENDING, []);
  const completed = new Set();
  for (const path of pending) {
    if (!existsSync(path)) { completed.add(path); continue; } // record gone -> stop tracking
    const { bytes, changed } = await upgradeOts(readFileSync(path));
    if (changed) writeFileSync(path, bytes);
    if (isComplete(bytes)) { completed.add(path); console.log(`upgraded complete: ${path}`); }
  }
  if (completed.size) pending = removeCompleted(pending, completed);

  // 2. Fetch current root.
  const res = await fetch(ROOT_URL);
  if (!res.ok) { console.log(`root fetch ${res.status}; skipping anchor this run`); writeJson(PENDING, pending); return; }
  const root = parseRoot(await res.text());

  // 3. Decide.
  const latest = readJson(LATEST, null);
  const now = Date.now();
  const decision = decideAnchor({ root, latest, now, heartbeatMs: HEARTBEAT_MS });
  console.log(`decision: anchor=${decision.anchor} (${decision.reason}) seqno=${root.seqno}`);
  if (!decision.anchor) { writeJson(PENDING, pending); return; }

  // 4. Write record, stamp it, record pending + latest.
  const { record, path } = buildAnchorRecord({ root, now, source: ROOT_URL });
  const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
  writeJson(path, record);
  const ots = await stampBytes(recordBytes);
  writeFileSync(`${path}.ots`, ots);
  pending = addPending(pending, `${path}.ots`);
  writeJson(PENDING, pending);
  writeJson(LATEST, { seqno: root.seqno, rootHash: root.rootHash, capturedAt: record.capturedAt, file: path });
  console.log(`anchored ${path}`);
}

main().catch((err) => { console.error(`anchor failed: ${err?.message ?? err}`); process.exit(1); });
