// scripts/lib/anchorDecision.mjs

export const LEGACY_SHARD = "legacy";
export const CHECKPOINT_FORMAT = "mypenny-checkpoint/v0";
export const CHECKPOINT_ORIGIN_PREFIX = "mypenny.ai/transparency-log/";

const SHARD_RE = /^(legacy|\d{4}-(0[1-9]|1[0-2]))$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** True for "legacy" or a UTC calendar month "YYYY-MM" (01–12). */
export function isShardName(s) {
  return typeof s === "string" && SHARD_RE.test(s);
}

/** Sort key for shards: "legacy" precedes every "YYYY-MM" month. */
export function shardOrderKey(shard) {
  return shard === LEGACY_SHARD ? "0000-00" : shard;
}

/** Parse the Worker's /api/log/root JSON, validating shape. */
export function parseRoot(text) {
  const o = JSON.parse(text);
  if (!Number.isInteger(o.seqno) || o.seqno < 0) throw new Error("root: bad seqno");
  if (typeof o.rootHash !== "string") throw new Error("root: bad rootHash");
  return { seqno: o.seqno, rootHash: o.rootHash };
}

/** Parse the Worker's /api/log/shards JSON, validating every shard name and state. */
export function parseShards(text) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.shards)) throw new Error("shards: missing shards array");
  return o.shards.map((s) => {
    if (!s || typeof s !== "object") throw new Error("shards: entry not an object");
    if (!isShardName(s.shard)) throw new Error(`shards: invalid shard ${JSON.stringify(s.shard)}`);
    if (s.state !== "open" && s.state !== "sealed") {
      throw new Error(`shards: invalid state ${JSON.stringify(s.state)} for ${s.shard}`);
    }
    return { shard: s.shard, state: s.state };
  });
}

/**
 * Parse and validate /api/log/<shard>/checkpoint. Verifies the C2SP note body
 * matches origin, size, and base64(rootHash) so a corrupt body is rejected
 * before stamping.
 */
export function parseCheckpoint(text, expectedShard) {
  if (!isShardName(expectedShard)) throw new Error(`checkpoint: invalid expected shard ${JSON.stringify(expectedShard)}`);
  const o = JSON.parse(text);
  if (!o || typeof o !== "object") throw new Error("checkpoint: not an object");
  if (o.format !== CHECKPOINT_FORMAT) throw new Error(`checkpoint: unsupported format ${JSON.stringify(o.format)}`);
  if (o.shard !== expectedShard) throw new Error(`checkpoint: shard ${JSON.stringify(o.shard)} !== ${expectedShard}`);
  const expectedOrigin = `${CHECKPOINT_ORIGIN_PREFIX}${expectedShard}`;
  if (o.origin !== expectedOrigin) throw new Error(`checkpoint: origin ${JSON.stringify(o.origin)} !== ${expectedOrigin}`);
  if (!Number.isInteger(o.size) || o.size < 0) throw new Error("checkpoint: bad size");
  if (typeof o.rootHash !== "string" || !HEX64.test(o.rootHash)) throw new Error("checkpoint: bad rootHash");
  if (typeof o.sealed !== "boolean") throw new Error("checkpoint: bad sealed flag");
  const expectedBody = `${expectedOrigin}\n${o.size}\n${Buffer.from(o.rootHash, "hex").toString("base64")}\n`;
  if (o.body !== expectedBody) throw new Error("checkpoint: body does not match origin/size/rootHash");
  if (o.sealed) {
    if (typeof o.sealedAt !== "number" || !Number.isFinite(o.sealedAt)) throw new Error("checkpoint: bad sealedAt");
    if (!isShardName(o.successor)) throw new Error(`checkpoint: bad successor ${JSON.stringify(o.successor)}`);
    return {
      format: o.format,
      origin: o.origin,
      shard: o.shard,
      size: o.size,
      rootHash: o.rootHash,
      sealed: true,
      sealedAt: o.sealedAt,
      successor: o.successor,
      body: o.body,
    };
  }
  return {
    format: o.format,
    origin: o.origin,
    shard: o.shard,
    size: o.size,
    rootHash: o.rootHash,
    sealed: false,
    body: o.body,
  };
}

/**
 * Normalize anchors/latest.json into { byShard: { [shard]: record } }.
 * An old pre-Phase-2 single record is migrated in memory as `legacy`.
 */
export function readLatestMap(raw) {
  if (!raw || typeof raw !== "object") return { byShard: {} };
  if (raw.byShard && typeof raw.byShard === "object" && !Array.isArray(raw.byShard)) {
    return { byShard: { ...raw.byShard } };
  }
  if (typeof raw.rootHash === "string" && Number.isInteger(raw.seqno)) {
    return { byShard: { [LEGACY_SHARD]: raw } };
  }
  return { byShard: {} };
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

/** Build the anchor record object + its repo-relative (or outDir-relative) path. */
export function buildAnchorRecord({ root, now, source, shard, anchorsDir = "anchors" }) {
  if (shard !== undefined && !isShardName(shard)) {
    throw new Error(`anchor: invalid shard ${JSON.stringify(shard)}`);
  }
  const iso = new Date(now).toISOString();          // 2026-06-13T15:00:11.500Z
  const compact = iso.replace(/[:.]/g, "").replace(/\d{3}Z$/, "Z"); // 2026-06-13T150011Z
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  const seq = String(root.seqno).padStart(6, "0");
  const shardTag = shard && shard !== LEGACY_SHARD ? `-${shard}` : "";
  const path = `${anchorsDir}/${yyyy}/${mm}/${compact}${shardTag}-${seq}.json`;
  const record = shard !== undefined
    ? { shard, seqno: root.seqno, rootHash: root.rootHash, capturedAt: iso, source }
    : { seqno: root.seqno, rootHash: root.rootHash, capturedAt: iso, source };
  return { record, path };
}

/** Build the one-time anchor record for a sealed shard's final checkpoint. */
export function buildSealedAnchorRecord({ checkpoint, now, source, anchorsDir = "anchors" }) {
  if (!checkpoint || checkpoint.sealed !== true) throw new Error("sealed anchor: checkpoint is not sealed");
  if (!isShardName(checkpoint.shard)) throw new Error(`sealed anchor: invalid shard ${JSON.stringify(checkpoint.shard)}`);
  const iso = new Date(now).toISOString();
  const path = `${anchorsDir}/sealed/${checkpoint.shard}.json`;
  const record = {
    format: checkpoint.format,
    origin: checkpoint.origin,
    shard: checkpoint.shard,
    seqno: checkpoint.size,
    size: checkpoint.size,
    rootHash: checkpoint.rootHash,
    sealed: true,
    sealedAt: checkpoint.sealedAt,
    successor: checkpoint.successor,
    body: checkpoint.body,
    capturedAt: iso,
    source,
  };
  return { record, path };
}
