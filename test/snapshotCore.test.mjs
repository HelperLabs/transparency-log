// test/snapshotCore.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { signedPayload, checkMonotonic, buildSnapshotRecord, snapshotPath, canonicalToSign, applySignature } from "../scripts/lib/snapshotCore.mjs";

test("signedPayload is the exact 3-line UTF-8 string", () => {
  assert.equal(signedPayload({ seqno: 12345, rootHash: "ab", timestamp: "2026-06-14T00:00:00Z" }),
    "12345\nab\n2026-06-14T00:00:00Z");
});

test("checkMonotonic: ok when no previous snapshot", () => {
  assert.deepEqual(checkMonotonic(null, { seqno: 1, timestamp: "2026-06-14T00:00:00Z" }), { ok: true });
});

test("checkMonotonic: ok when seqno and timestamp advance", () => {
  const prev = { seqno: 10, timestamp: "2026-06-07T00:00:00Z" };
  assert.deepEqual(checkMonotonic(prev, { seqno: 12, timestamp: "2026-06-14T00:00:00Z" }), { ok: true });
});

test("checkMonotonic: ok when seqno equal (idle week) and timestamp advances", () => {
  const prev = { seqno: 10, timestamp: "2026-06-07T00:00:00Z" };
  assert.equal(checkMonotonic(prev, { seqno: 10, timestamp: "2026-06-14T00:00:00Z" }).ok, true);
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

test("canonicalToSign: throws when live root disagrees with the existing snapshot", () => {
  const existing = { seqno: 5, rootHash: "aa", timestamp: "t", signatures: [] };
  assert.throws(() => canonicalToSign(existing, { seqno: 6, rootHash: "aa", timestamp: "t2" }), /disagree/);
  assert.throws(() => canonicalToSign(existing, { seqno: 5, rootHash: "bb", timestamp: "t2" }), /disagree/);
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
