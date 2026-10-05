// test/snapshotCore.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { signedPayload, checkMonotonic, buildSnapshotRecord, snapshotPath, canonicalToSign, applySignature, validateLiveRoot, PAYLOAD_PREFIX } from "../scripts/lib/snapshotCore.mjs";

test("signedPayload is the domain-separation tag plus the exact 3-line UTF-8 string", () => {
  assert.equal(PAYLOAD_PREFIX, "mypenny-tlog-snapshot-v1\n");
  assert.equal(signedPayload({ seqno: 12345, rootHash: "ab", timestamp: "2026-06-14T00:00:00Z" }),
    "mypenny-tlog-snapshot-v1\n12345\nab\n2026-06-14T00:00:00Z");
});

test("checkMonotonic: ok when no previous snapshot", () => {
  assert.deepEqual(checkMonotonic(null, { seqno: 1, timestamp: "2026-06-14T00:00:00Z" }), { ok: true });
});

test("checkMonotonic: ok when seqno and timestamp advance", () => {
  const prev = { seqno: 10, timestamp: "2026-06-07T00:00:00Z" };
  assert.deepEqual(checkMonotonic(prev, { seqno: 12, timestamp: "2026-06-14T00:00:00Z" }), { ok: true });
});

test("checkMonotonic: ok when seqno and rootHash are equal (idle week) and timestamp advances", () => {
  const prev = { seqno: 10, rootHash: "aa", timestamp: "2026-06-07T00:00:00Z" };
  assert.equal(checkMonotonic(prev, { seqno: 10, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z" }).ok, true);
});

test("checkMonotonic: rejects the same seqno with a different rootHash (same-size history rewrite)", () => {
  const prev = { seqno: 10, rootHash: "aa", timestamp: "2026-06-07T00:00:00Z" };
  const r = checkMonotonic(prev, { seqno: 10, rootHash: "bb", timestamp: "2026-06-14T00:00:00Z" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /rootHash/);
});

test("checkMonotonic: a larger seqno may carry a different rootHash", () => {
  const prev = { seqno: 10, rootHash: "aa", timestamp: "2026-06-07T00:00:00Z" };
  assert.equal(checkMonotonic(prev, { seqno: 11, rootHash: "bb", timestamp: "2026-06-14T00:00:00Z" }).ok, true);
});

test("checkMonotonic: rejects seqno regression", () => {
  const prev = { seqno: 10, timestamp: "2026-06-07T00:00:00Z" };
  const r = checkMonotonic(prev, { seqno: 9, timestamp: "2026-06-14T00:00:00Z" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /seqno/);
});

test("checkMonotonic: rejects timestamp regression", () => {
  const prev = { seqno: 10, timestamp: "2026-06-07T00:00:00Z" };
  const r = checkMonotonic(prev, { seqno: 11, timestamp: "2026-06-01T00:00:00Z" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timestamp/);
});

test("buildSnapshotRecord includes one signature; snapshotPath is date-named", () => {
  const rec = buildSnapshotRecord({ seqno: 5, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z",
    owner: "aaron", signatureB64: "QUJD" });
  assert.deepEqual(rec.signatures, [{ owner: "aaron", signature: "QUJD" }]);
  assert.equal(snapshotPath("2026-06-14T00:00:00Z"), "snapshots/2026-06-14.json");
});

test("canonicalToSign: new snapshot uses the live fields", () => {
  assert.deepEqual(
    canonicalToSign(null, { seqno: 5, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z" }),
    { seqno: 5, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z" });
});

test("canonicalToSign: co-sign signs the EXISTING timestamp, not the live one", () => {
  const existing = { seqno: 5, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z", signatures: [{ owner: "aaron", signature: "S1" }] };
  // Second signer's wall-clock is later, but the canonical timestamp stays the file's.
  assert.deepEqual(
    canonicalToSign(existing, { seqno: 5, rootHash: "aa", timestamp: "2026-06-14T09:30:00Z" }),
    { seqno: 5, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z" });
});

test("canonicalToSign: co-sign takes seqno, rootHash and timestamp from the file even when the live log has grown", () => {
  const existing = { seqno: 5, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z", signatures: [{ owner: "aaron", signature: "S1" }] };
  // The log appends continuously. Hours later the live root is ahead; the
  // second signer still attests to the statement the first signer made.
  assert.deepEqual(
    canonicalToSign(existing, { seqno: 9, rootHash: "bb", timestamp: "2026-06-14T09:30:00Z" }),
    { seqno: 5, rootHash: "aa", timestamp: "2026-06-14T00:00:00Z" });
});

test("canonicalToSign: throws only when the live root is BEHIND the recorded seqno", () => {
  const existing = { seqno: 5, rootHash: "aa", timestamp: "t", signatures: [] };
  assert.throws(() => canonicalToSign(existing, { seqno: 4, rootHash: "aa", timestamp: "t2" }), /behind/);
  assert.doesNotThrow(() => canonicalToSign(existing, { seqno: 5, rootHash: "aa", timestamp: "t2" }));
  assert.doesNotThrow(() => canonicalToSign(existing, { seqno: 6, rootHash: "bb", timestamp: "t2" }));
});

test("applySignature: new record has exactly one signature", () => {
  const r = applySignature(null, { seqno: 5, rootHash: "aa", timestamp: "t" }, "aaron", "SIG");
  assert.deepEqual(r, { seqno: 5, rootHash: "aa", timestamp: "t", signatures: [{ owner: "aaron", signature: "SIG" }] });
});

test("applySignature: co-sign appends the second signature", () => {
  const existing = { seqno: 5, rootHash: "aa", timestamp: "t", signatures: [{ owner: "aaron", signature: "S1" }] };
  const r = applySignature(existing, { seqno: 5, rootHash: "aa", timestamp: "t" }, "peter", "S2");
  assert.deepEqual(r.signatures, [{ owner: "aaron", signature: "S1" }, { owner: "peter", signature: "S2" }]);
});

test("applySignature: idempotent for the same owner (no duplicate signature)", () => {
  const existing = { seqno: 5, rootHash: "aa", timestamp: "t", signatures: [{ owner: "aaron", signature: "S1" }] };
  const r = applySignature(existing, { seqno: 5, rootHash: "aa", timestamp: "t" }, "aaron", "S2");
  assert.deepEqual(r.signatures, [{ owner: "aaron", signature: "S1" }]);
});

const GOOD = "0123456789abcdef".repeat(4);

test("validateLiveRoot: accepts an integer seqno and a 64-char lowercase hex rootHash", () => {
  assert.deepEqual(validateLiveRoot({ seqno: 2731111, rootHash: GOOD }), { seqno: 2731111, rootHash: GOOD });
  assert.deepEqual(validateLiveRoot({ seqno: 0, rootHash: GOOD }), { seqno: 0, rootHash: GOOD });
});

test("validateLiveRoot: rejects anything verify-signatures.mjs would reject", () => {
  const bad = [
    null, "x", [], {},
    { seqno: -1, rootHash: GOOD },
    { seqno: 1.5, rootHash: GOOD },
    { seqno: "1", rootHash: GOOD },
    { seqno: 1, rootHash: GOOD.toUpperCase() },
    { seqno: 1, rootHash: GOOD.slice(1) },
    { seqno: 1, rootHash: GOOD + "0" },
    { seqno: 1, rootHash: 12345 },
    { seqno: 1 },
  ];
  for (const root of bad) assert.throws(() => validateLiveRoot(root), /root/, JSON.stringify(root));
});

test("validateLiveRoot: rejects the newline-injection pair that collides without a tag", () => {
  assert.throws(() => validateLiveRoot({ seqno: "1\na", rootHash: "b" }));
  assert.throws(() => validateLiveRoot({ seqno: 1, rootHash: "a\nb" }));
});
