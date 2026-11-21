// scripts/lib/snapshotCore.mjs
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_ORIGIN_PREFIX,
  LEGACY_SHARD,
  isShardName,
  shardOrderKey,
} from "./anchorDecision.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Domain-separation tags, the first line of every signed payload. They keep a
 * snapshot signature from being a valid signature over some other message the
 * same key might sign. Bump the version, and .github/scripts/verify-signatures.mjs
 * with it, if the payload format ever changes.
 *
 * - v1 (pre-Phase-2 snapshots without `shard`):
 *     mypenny-tlog-snapshot-v1\n<seqno>\n<rootHash>\n<timestamp>
 * - v2 (Phase 2 shard-aware snapshots with `shard`):
 *     mypenny-tlog-snapshot-v2\n<shard>\n<seqno>\n<rootHash>\n<timestamp>
 */
export const PAYLOAD_PREFIX = "mypenny-tlog-snapshot-v1\n";
export const PAYLOAD_PREFIX_V2 = "mypenny-tlog-snapshot-v2\n";

export function signedPayload({ shard, seqno, rootHash, timestamp }) {
  if (shard !== undefined) {
    return `${PAYLOAD_PREFIX_V2}${shard}\n${seqno}\n${rootHash}\n${timestamp}`;
  }
  return `${PAYLOAD_PREFIX}${seqno}\n${rootHash}\n${timestamp}`;
}

/**
 * Check a root or checkpoint fetched from the log worker before it can be
 * signed, with the same rules .github/scripts/verify-signatures.mjs applies at
 * push time. The worker is the party this system audits, so its output is not
 * trusted. A shard, seqno, or rootHash that carried a newline would also let
 * two different statements share one payload.
 */
export function validateLiveRoot(root) {
  if (!root || typeof root !== "object") throw new Error("live root: not an object");
  const { shard, rootHash } = root;
  const seqno = root.seqno !== undefined ? root.seqno : root.size;
  if (shard !== undefined && !isShardName(shard)) {
    throw new Error(`live root: bad shard ${JSON.stringify(shard)}`);
  }
  if (!Number.isInteger(seqno) || seqno < 0) throw new Error(`live root: bad seqno ${JSON.stringify(seqno)}`);
  if (typeof rootHash !== "string" || !HEX64.test(rootHash)) throw new Error("live root: rootHash is not 64-char lowercase hex");
  return shard !== undefined ? { shard, seqno, rootHash } : { seqno, rootHash };
}

/**
 * Validate leaf 1 (the ShardLink) of `expectedShard` when transitioning from
 * a prior snapshot on `prevShard` at `prevSeqno`.
 */
export function validateShardLink(leaf, { expectedShard, prevShard, prevSeqno, prevRootHash }) {
  if (!leaf || typeof leaf !== "object") {
    return { ok: false, reason: `shard changed (${prevShard} -> ${expectedShard}) without a ShardLink leaf` };
  }
  if (leaf.type !== "ShardLink") {
    return { ok: false, reason: `event/1 of ${expectedShard} is not a ShardLink (got ${JSON.stringify(leaf.type)})` };
  }
  if (leaf.eventId !== `shardlink:${expectedShard}`) {
    return { ok: false, reason: `ShardLink eventId ${JSON.stringify(leaf.eventId)} does not match shardlink:${expectedShard}` };
  }
  const payload = leaf.payload;
  if (!payload || typeof payload !== "object" || payload.shard !== expectedShard) {
    return { ok: false, reason: `ShardLink payload.shard does not match ${expectedShard}` };
  }
  const pred = payload.predecessor;
  if (!pred || typeof pred !== "object") {
    return { ok: false, reason: `ShardLink for ${expectedShard} is missing predecessor checkpoint` };
  }
  if (pred.format !== CHECKPOINT_FORMAT || pred.sealed !== true) {
    return { ok: false, reason: `ShardLink predecessor is not a sealed ${CHECKPOINT_FORMAT} checkpoint` };
  }
  if (pred.successor !== expectedShard) {
    return { ok: false, reason: `ShardLink predecessor.successor ${JSON.stringify(pred.successor)} !== ${expectedShard}` };
  }
  if (pred.shard !== prevShard) {
    return { ok: false, reason: `ShardLink predecessor.shard ${JSON.stringify(pred.shard)} !== previous snapshot shard ${prevShard}` };
  }
  const expectedOrigin = `${CHECKPOINT_ORIGIN_PREFIX}${prevShard}`;
  if (pred.origin !== expectedOrigin) {
    return { ok: false, reason: `ShardLink predecessor.origin ${JSON.stringify(pred.origin)} !== ${expectedOrigin}` };
  }
  if (!Number.isInteger(pred.size) || pred.size < 0) {
    return { ok: false, reason: `ShardLink predecessor has bad size ${JSON.stringify(pred.size)}` };
  }
  if (typeof pred.rootHash !== "string" || !HEX64.test(pred.rootHash)) {
    return { ok: false, reason: "ShardLink predecessor has bad rootHash" };
  }
  const expectedBody = `${expectedOrigin}\n${pred.size}\n${Buffer.from(pred.rootHash, "hex").toString("base64")}\n`;
  if (pred.body !== expectedBody) {
    return { ok: false, reason: "ShardLink predecessor body does not match origin/size/rootHash" };
  }
  if (pred.size < prevSeqno) {
    return { ok: false, reason: `ShardLink predecessor size regressed: ${pred.size} < ${prevSeqno}` };
  }
  if (pred.size === prevSeqno && prevRootHash && pred.rootHash !== prevRootHash) {
    return { ok: false, reason: `ShardLink predecessor at same size ${prevSeqno} has a different rootHash` };
  }
  return { ok: true };
}

/**
 * Monotonicity SANITY-GATE (not a cryptographic non-rewrite proof — see the
 * design spec's Follow-up on a consistency-proof endpoint).
 *
 * Within one shard: rejects a seqno regression, the same seqno with a different
 * rootHash (a same-size history rewrite), and a timestamp that did not advance.
 *
 * Across a shard change: rejects backward shard moves and requires `shardLink`
 * (the new shard's event/1) to chain directly from the previous snapshot's
 * shard at a size >= the previous snapshot's seqno.
 */
export function checkMonotonic(prevSnapshot, next, { shardLink } = {}) {
  if (!prevSnapshot) return { ok: true };
  if (Date.parse(next.timestamp) <= Date.parse(prevSnapshot.timestamp)) {
    return { ok: false, reason: `timestamp did not advance: ${next.timestamp} <= ${prevSnapshot.timestamp}` };
  }
  const prevShard = prevSnapshot.shard ?? LEGACY_SHARD;
  const nextShard = next.shard ?? LEGACY_SHARD;
  if (prevShard === nextShard) {
    if (next.seqno < prevSnapshot.seqno) {
      return { ok: false, reason: `seqno regression: ${next.seqno} < ${prevSnapshot.seqno}` };
    }
    if (next.seqno === prevSnapshot.seqno && next.rootHash !== prevSnapshot.rootHash) {
      return { ok: false, reason: `same seqno ${next.seqno} but a different rootHash: ${next.rootHash} != ${prevSnapshot.rootHash}` };
    }
    return { ok: true };
  }
  if (shardOrderKey(nextShard) <= shardOrderKey(prevShard)) {
    return { ok: false, reason: `shard regression: ${nextShard} <= ${prevShard}` };
  }
  return validateShardLink(shardLink, {
    expectedShard: nextShard,
    prevShard,
    prevSeqno: prevSnapshot.seqno,
    prevRootHash: prevSnapshot.rootHash,
  });
}

export function buildSnapshotRecord({ shard, seqno, rootHash, timestamp, owner, signatureB64 }) {
  const base = shard !== undefined
    ? { shard, seqno, rootHash, timestamp }
    : { seqno, rootHash, timestamp };
  return { ...base, signatures: [{ owner, signature: signatureB64 }] };
}

/**
 * Resolve the canonical {shard?, seqno, rootHash, timestamp} that must be SIGNED.
 *
 * A co-signer attests to the statement already in the file, so for an
 * `existing` snapshot all fields come from that file. The one red flag is a
 * live log BEHIND the recorded snapshot (shrank on the same shard, moved to an
 * earlier shard, or rolled over without a valid ShardLink proving the sealed
 * predecessor reached existing.seqno), so that throws.
 */
export function canonicalToSign(existing, live, { shardLink } = {}) {
  if (!existing) {
    return live.shard !== undefined
      ? { shard: live.shard, seqno: live.seqno, rootHash: live.rootHash, timestamp: live.timestamp }
      : { seqno: live.seqno, rootHash: live.rootHash, timestamp: live.timestamp };
  }
  const existingShard = existing.shard ?? LEGACY_SHARD;
  const liveShard = live.shard ?? LEGACY_SHARD;
  if (liveShard === existingShard) {
    if (live.seqno < existing.seqno) {
      throw new Error(`live log is behind the recorded snapshot (seqno ${live.seqno} < ${existing.seqno}) — investigate before co-signing`);
    }
  } else if (shardOrderKey(liveShard) < shardOrderKey(existingShard)) {
    throw new Error(`live log is behind the recorded snapshot (shard ${liveShard} < ${existingShard}) — investigate before co-signing`);
  } else {
    const linkCheck = validateShardLink(shardLink, {
      expectedShard: liveShard,
      prevShard: existingShard,
      prevSeqno: existing.seqno,
      prevRootHash: existing.rootHash,
    });
    if (!linkCheck.ok) {
      throw new Error(`live log rolled over without valid ShardLink (${linkCheck.reason}) — investigate before co-signing`);
    }
  }
  return existing.shard !== undefined
    ? { shard: existing.shard, seqno: existing.seqno, rootHash: existing.rootHash, timestamp: existing.timestamp }
    : { seqno: existing.seqno, rootHash: existing.rootHash, timestamp: existing.timestamp };
}

/**
 * Produce the snapshot record to write: a new single-signature record, or the
 * existing record with this owner's signature appended (idempotent per owner).
 */
export function applySignature(existing, canonical, owner, signatureB64) {
  if (!existing) return buildSnapshotRecord({ ...canonical, owner, signatureB64 });
  if (existing.signatures.some((s) => s.owner === owner)) return existing;
  return { ...existing, signatures: [...existing.signatures, { owner, signature: signatureB64 }] };
}

export function snapshotPath(timestamp, dir = "snapshots") {
  return `${dir}/${new Date(timestamp).toISOString().slice(0, 10)}.json`;
}
