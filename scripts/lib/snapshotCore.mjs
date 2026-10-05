// scripts/lib/snapshotCore.mjs

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Domain-separation tag, the first line of every signed payload. It keeps a
 * snapshot signature from being a valid signature over some other message the
 * same key might sign. Bump the version, and .github/scripts/verify-signatures.mjs
 * with it, if the payload format ever changes.
 */
export const PAYLOAD_PREFIX = "mypenny-tlog-snapshot-v1\n";

export function signedPayload({ seqno, rootHash, timestamp }) {
  return `${PAYLOAD_PREFIX}${seqno}\n${rootHash}\n${timestamp}`;
}

/**
 * Check a root fetched from the log worker before it can be signed, with the
 * same rules .github/scripts/verify-signatures.mjs applies at push time. The
 * worker is the party this system audits, so its output is not trusted. A
 * seqno or rootHash that carried a newline would also let two different
 * statements share one payload.
 */
export function validateLiveRoot(root) {
  if (!root || typeof root !== "object") throw new Error("live root: not an object");
  const { seqno, rootHash } = root;
  if (!Number.isInteger(seqno) || seqno < 0) throw new Error(`live root: bad seqno ${JSON.stringify(seqno)}`);
  if (typeof rootHash !== "string" || !HEX64.test(rootHash)) throw new Error("live root: rootHash is not 64-char lowercase hex");
  return { seqno, rootHash };
}

/**
 * Monotonicity SANITY-GATE (not a cryptographic non-rewrite proof — see the
 * design spec's Follow-up on a consistency-proof endpoint). Rejects, vs the
 * previous signed snapshot: a seqno regression, the same seqno with a
 * different rootHash (a same-size history rewrite, the case this gate exists
 * to catch), and a timestamp that did not advance.
 */
export function checkMonotonic(prevSnapshot, next) {
  if (!prevSnapshot) return { ok: true };
  if (next.seqno < prevSnapshot.seqno) {
    return { ok: false, reason: `seqno regression: ${next.seqno} < ${prevSnapshot.seqno}` };
  }
  if (next.seqno === prevSnapshot.seqno && next.rootHash !== prevSnapshot.rootHash) {
    return { ok: false, reason: `same seqno ${next.seqno} but a different rootHash: ${next.rootHash} != ${prevSnapshot.rootHash}` };
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
 *
 * A co-signer attests to the statement already in the file, so for an
 * `existing` snapshot all three fields come from that file and nothing is
 * compared against the live root. The log appends continuously, so two founders
 * signing hours apart will see different live roots, and verification rebuilds
 * the payload from the file anyway. The one thing that is a real red flag is a
 * live root BEHIND the recorded seqno (the log shrank), so that alone throws.
 * New snapshots sign the live values.
 */
export function canonicalToSign(existing, live) {
  if (!existing) return { seqno: live.seqno, rootHash: live.rootHash, timestamp: live.timestamp };
  if (live.seqno < existing.seqno) {
    throw new Error(`live log is behind the recorded snapshot (seqno ${live.seqno} < ${existing.seqno}) — investigate before co-signing`);
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

export function snapshotPath(timestamp, dir = "snapshots") {
  return `${dir}/${new Date(timestamp).toISOString().slice(0, 10)}.json`;
}
