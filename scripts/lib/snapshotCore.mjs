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

export function snapshotPath(timestamp) {
  return `snapshots/${new Date(timestamp).toISOString().slice(0, 10)}.json`;
}
