// scripts/lib/snapshotCore.mjs

export function signedPayload({ seqno, rootHash, timestamp }) {
  return `${seqno}\n${rootHash}\n${timestamp}`;
}

/**
 * Monotonicity SANITY-GATE (not a cryptographic non-rewrite proof — see the
 * design spec's Follow-up on a consistency-proof endpoint). Rejects a seqno or
 * timestamp regression vs the previous signed snapshot.
 */
export function checkMonotonic(prevSnapshot, next) {
  if (!prevSnapshot) return { ok: true };
  if (next.seqno < prevSnapshot.seqno) {
    return { ok: false, reason: `seqno regression: ${next.seqno} < ${prevSnapshot.seqno}` };
  }
  if (Date.parse(next.timestamp) <= Date.parse(prevSnapshot.timestamp)) {
    return { ok: false, reason: `timestamp did not advance: ${next.timestamp} <= ${prevSnapshot.timestamp}` };
  }
  return { ok: true };
}

export function buildSnapshotRecord({ seqno, rootHash, timestamp, owner, signatureB64 }) {
  return { seqno, rootHash, timestamp, signatures: [{ owner, signature: signatureB64 }] };
}

/**
 * Resolve the canonical {seqno, rootHash, timestamp} that must be SIGNED.
 * For a co-sign (an `existing` snapshot already on disk for the same day), the
 * signed payload must match what's on disk — including the FIRST signer's
 * timestamp — because verification rebuilds the payload from the file. So
 * co-signers sign the existing timestamp, NOT their own wall-clock; otherwise
 * their signature fails verification. New snapshots sign the live values.
 */
export function canonicalToSign(existing, live) {
  if (!existing) return { seqno: live.seqno, rootHash: live.rootHash, timestamp: live.timestamp };
  if (existing.seqno !== live.seqno || existing.rootHash !== live.rootHash) {
    throw new Error("existing snapshot for today disagrees on seqno/rootHash — investigate before co-signing");
  }
  return { seqno: existing.seqno, rootHash: existing.rootHash, timestamp: existing.timestamp };
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

export function snapshotPath(timestamp) {
  return `snapshots/${new Date(timestamp).toISOString().slice(0, 10)}.json`;
}
