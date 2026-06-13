// scripts/lib/anchorDecision.mjs

/** Parse the Worker's /api/log/root JSON, validating shape. */
export function parseRoot(text) {
  const o = JSON.parse(text);
  if (!Number.isInteger(o.seqno) || o.seqno < 0) throw new Error("root: bad seqno");
  if (typeof o.rootHash !== "string") throw new Error("root: bad rootHash");
  return { seqno: o.seqno, rootHash: o.rootHash };
}

/**
 * Decide whether to write a new anchor.
 *   - empty log (seqno 0 / rootHash "") -> skip
 *   - no prior anchor -> anchor
 *   - rootHash changed -> anchor
 *   - unchanged but >= heartbeatMs since last -> anchor (liveness heartbeat)
 *   - otherwise -> skip
 */
export function decideAnchor({ root, latest, now, heartbeatMs }) {
  // seqno is the 1-based Merkle tree size; the Worker returns seqno 0 / rootHash ""
  // only for an empty log (the first real append is seqno 1).
  if (root.seqno === 0 || root.rootHash === "") {
    return { anchor: false, reason: "empty log" };
  }
  if (!latest) return { anchor: true, reason: "no prior anchor" };
  if (latest.rootHash !== root.rootHash) return { anchor: true, reason: "rootHash changed" };
  const elapsed = now - Date.parse(latest.capturedAt);
  if (elapsed >= heartbeatMs) return { anchor: true, reason: "heartbeat" };
  return { anchor: false, reason: "unchanged within heartbeat" };
}

/** Build the anchor record object + its repo-relative path. */
export function buildAnchorRecord({ root, now, source }) {
  const iso = new Date(now).toISOString();          // 2026-06-13T15:00:11.500Z
  const compact = iso.replace(/[:.]/g, "").replace(/\d{3}Z$/, "Z"); // 2026-06-13T150011Z
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  const seq = String(root.seqno).padStart(6, "0");
  const path = `anchors/${yyyy}/${mm}/${compact}-${seq}.json`;
  const record = { seqno: root.seqno, rootHash: root.rootHash, capturedAt: iso, source };
  return { record, path };
}
