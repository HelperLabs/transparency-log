// test/snapshotCore.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signedPayload,
  checkMonotonic,
  buildSnapshotRecord,
  snapshotPath,
  canonicalToSign,
  applySignature,
  validateLiveRoot,
  PAYLOAD_PREFIX,
  PAYLOAD_PREFIX_V2,
} from "../scripts/lib/snapshotCore.mjs";

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

test("signedPayload v2 includes shard and v2 domain tag when shard is present", () => {
  assert.equal(PAYLOAD_PREFIX_V2, "mypenny-tlog-snapshot-v2\n");
  assert.equal(
    signedPayload({ shard: "2026-12", seqno: 42, rootHash: GOOD, timestamp: "2026-12-06T00:00:00Z" }),
    `mypenny-tlog-snapshot-v2\n2026-12\n42\n${GOOD}\n2026-12-06T00:00:00Z`,
  );
});

test("validateLiveRoot: accepts checkpoint shape ({shard, size, rootHash}) and rejects bad shard", () => {
  assert.deepEqual(
    validateLiveRoot({ shard: "2026-12", size: 42, rootHash: GOOD }),
    { shard: "2026-12", seqno: 42, rootHash: GOOD },
  );
  assert.throws(() => validateLiveRoot({ shard: "2026-13", size: 1, rootHash: GOOD }), /shard/);
  assert.throws(() => validateLiveRoot({ shard: "legacy\n2026-12", size: 1, rootHash: GOOD }), /shard/);
});

function makeShardLink(shard, predShard, predSize, predRootHash, overrides = {}) {
  const origin = `mypenny.ai/transparency-log/${predShard}`;
  const body = `${origin}\n${predSize}\n${Buffer.from(predRootHash, "hex").toString("base64")}\n`;
  return {
    eventId: `shardlink:${shard}`,
    type: "ShardLink",
    payload: {
      shard,
      predecessor: {
        format: "mypenny-checkpoint/v0",
        origin,
        shard: predShard,
        size: predSize,
        rootHash: predRootHash,
        sealed: true,
        sealedAt: Date.parse("2026-12-01T00:00:01Z"),
        successor: shard,
        body,
        ...(overrides.predecessor ?? {}),
      },
      ...(overrides.payload ?? {}),
    },
    ...(overrides.leaf ?? {}),
  };
}

test("checkMonotonic across a shard change: requires valid ShardLink proving predecessor reached prev size", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);
  const prev = { seqno: 7400000, rootHash: H1, timestamp: "2026-11-29T00:00:00Z" }; // pre-Phase-2 legacy snapshot
  const next = { shard: "2026-12", seqno: 15, rootHash: H2, timestamp: "2026-12-06T00:00:00Z" };

  // Valid ShardLink with predecessor.size > prev.seqno -> ok
  const okLink = makeShardLink("2026-12", "legacy", 7400050, "c".repeat(64));
  assert.deepEqual(checkMonotonic(prev, next, { shardLink: okLink }), { ok: true });

  // Valid ShardLink with predecessor.size === prev.seqno and matching rootHash -> ok
  const sameSizeOk = makeShardLink("2026-12", "legacy", 7400000, H1);
  assert.deepEqual(checkMonotonic(prev, next, { shardLink: sameSizeOk }), { ok: true });

  // Same size with DIFFERENT rootHash -> rejected (seal rewrite)
  const sameSizeBad = makeShardLink("2026-12", "legacy", 7400000, H2);
  assert.equal(checkMonotonic(prev, next, { shardLink: sameSizeBad }).ok, false);

  // Missing ShardLink -> rejected
  assert.equal(checkMonotonic(prev, next).ok, false);

  // Wrong predecessor shard -> rejected
  const wrongPred = makeShardLink("2026-12", "2026-11", 7400050, H1);
  assert.equal(checkMonotonic(prev, next, { shardLink: wrongPred }).ok, false);

  // Predecessor shrank below previous snapshot size -> rejected
  const shrank = makeShardLink("2026-12", "legacy", 7399999, H1);
  assert.equal(checkMonotonic(prev, next, { shardLink: shrank }).ok, false);

  // Backward shard regression -> rejected even with a ShardLink
  const decPrev = { shard: "2026-12", seqno: 15, rootHash: H2, timestamp: "2026-12-06T00:00:00Z" };
  const backNext = { shard: "legacy", seqno: 7400051, rootHash: H1, timestamp: "2026-12-13T00:00:00Z" };
  assert.equal(checkMonotonic(decPrev, backNext, { shardLink: okLink }).ok, false);
});
