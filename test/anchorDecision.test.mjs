// test/anchorDecision.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRoot,
  parseShards,
  parseCheckpoint,
  readLatestMap,
  isShardName,
  decideAnchor,
  buildAnchorRecord,
  buildSealedAnchorRecord,
} from "../scripts/lib/anchorDecision.mjs";

const SOURCE = "https://example/api/log/root";
const HEARTBEAT_MS = 24 * 60 * 60 * 1000;

test("parseRoot accepts a well-formed root", () => {
  assert.deepEqual(parseRoot('{"seqno":42,"rootHash":"ab12"}'), { seqno: 42, rootHash: "ab12" });
});

test("parseRoot rejects malformed payloads", () => {
  assert.throws(() => parseRoot("not json"));
  assert.throws(() => parseRoot('{"seqno":"x","rootHash":"ab"}'));
  assert.throws(() => parseRoot('{"seqno":1}'));
});

test("decideAnchor: skip empty log", () => {
  const d = decideAnchor({ root: { seqno: 0, rootHash: "" }, latest: null, now: 1000, heartbeatMs: HEARTBEAT_MS });
  assert.equal(d.anchor, false);
  assert.match(d.reason, /empty/);
});

test("decideAnchor: anchor when no prior anchor", () => {
  const d = decideAnchor({ root: { seqno: 5, rootHash: "aa" }, latest: null, now: 1000, heartbeatMs: HEARTBEAT_MS });
  assert.equal(d.anchor, true);
});

test("decideAnchor: anchor when rootHash changed", () => {
  const latest = { seqno: 5, rootHash: "aa", capturedAt: "1970-01-01T00:00:00Z" };
  const d = decideAnchor({ root: { seqno: 6, rootHash: "bb" }, latest, now: 1000, heartbeatMs: HEARTBEAT_MS });
  assert.equal(d.anchor, true);
});

test("decideAnchor: skip when unchanged and within heartbeat", () => {
  const latest = { seqno: 5, rootHash: "aa", capturedAt: new Date(0).toISOString() };
  const d = decideAnchor({ root: { seqno: 5, rootHash: "aa" }, latest, now: 1000, heartbeatMs: HEARTBEAT_MS });
  assert.equal(d.anchor, false);
  assert.match(d.reason, /unchanged/);
});

test("decideAnchor: heartbeat fires when unchanged past the window", () => {
  const latest = { seqno: 5, rootHash: "aa", capturedAt: new Date(0).toISOString() };
  const d = decideAnchor({ root: { seqno: 5, rootHash: "aa" }, latest, now: HEARTBEAT_MS + 1, heartbeatMs: HEARTBEAT_MS });
  assert.equal(d.anchor, true);
  assert.match(d.reason, /heartbeat/);
});

test("buildAnchorRecord produces fs-safe path and correct record", () => {
  const now = Date.parse("2026-06-13T15:00:11.500Z");
  const { record, path } = buildAnchorRecord({ root: { seqno: 18472, rootHash: "deadbeef" }, now, source: SOURCE });
  assert.equal(path, "anchors/2026/06/2026-06-13T150011Z-018472.json");
  assert.equal(record.seqno, 18472);
  assert.equal(record.rootHash, "deadbeef");
  assert.equal(record.source, SOURCE);
  assert.equal(record.capturedAt, "2026-06-13T15:00:11.500Z");
  assert.doesNotMatch(path, /:/);        // fs-safe: no colons anywhere in the path
});

test("isShardName accepts legacy and YYYY-MM, rejects malformed or path-traversal values", () => {
  assert.equal(isShardName("legacy"), true);
  assert.equal(isShardName("2026-12"), true);
  assert.equal(isShardName("2027-01"), true);
  for (const bad of ["", "2026-00", "2026-13", "2026-1", "../etc", "legacy\n2026-12", "singleton", 123, null]) {
    assert.equal(isShardName(bad), false, JSON.stringify(bad));
  }
});

test("parseShards validates /api/log/shards response", () => {
  const shards = parseShards(JSON.stringify({
    shards: [
      { shard: "legacy", state: "sealed", size: 100, rootHash: "a".repeat(64), successor: "2026-12" },
      { shard: "2026-12", state: "open", openedAt: 1700000000000 },
    ],
  }));
  assert.deepEqual(shards, [
    { shard: "legacy", state: "sealed" },
    { shard: "2026-12", state: "open" },
  ]);
  assert.throws(() => parseShards('{"shards":[{"shard":"../bad","state":"open"}]}'));
  assert.throws(() => parseShards('{"shards":[{"shard":"legacy","state":"weird"}]}'));
  assert.throws(() => parseShards('{}'));
});

test("parseCheckpoint validates body consistency and sealed fields", () => {
  const rootHash = "a".repeat(64);
  const b64 = Buffer.from(rootHash, "hex").toString("base64");
  const body = `mypenny.ai/transparency-log/legacy\n100\n${b64}\n`;
  const sealed = parseCheckpoint(JSON.stringify({
    format: "mypenny-checkpoint/v0",
    origin: "mypenny.ai/transparency-log/legacy",
    shard: "legacy",
    size: 100,
    rootHash,
    sealed: true,
    sealedAt: 1796083200000,
    successor: "2026-12",
    body,
  }), "legacy");
  assert.equal(sealed.size, 100);
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.body, body);

  // Tampered body must fail
  assert.throws(() => parseCheckpoint(JSON.stringify({
    format: "mypenny-checkpoint/v0",
    origin: "mypenny.ai/transparency-log/legacy",
    shard: "legacy",
    size: 100,
    rootHash,
    sealed: true,
    sealedAt: 1796083200000,
    successor: "2026-12",
    body: `mypenny.ai/transparency-log/legacy\n999\n${b64}\n`,
  }), "legacy"));

  // Mismatched expectedShard must fail
  assert.throws(() => parseCheckpoint(JSON.stringify({
    format: "mypenny-checkpoint/v0",
    origin: "mypenny.ai/transparency-log/legacy",
    shard: "legacy",
    size: 100,
    rootHash,
    sealed: false,
    body,
  }), "2026-12"));
});

test("readLatestMap migrates an old single-record latest.json to byShard.legacy", () => {
  assert.deepEqual(readLatestMap(null), { byShard: {} });
  const old = { seqno: 7, rootHash: "aa", capturedAt: "2026-10-05T00:00:00Z", file: "anchors/x.json" };
  assert.deepEqual(readLatestMap(old), { byShard: { legacy: old } });
  const modern = { byShard: { "2026-12": { seqno: 3, rootHash: "bb", capturedAt: "2026-12-01T01:00:00Z", file: "anchors/y.json" } } };
  assert.deepEqual(readLatestMap(modern), modern);
});

test("buildAnchorRecord includes shard in path and record for monthly shards", () => {
  const now = Date.parse("2026-12-01T01:00:00.000Z");
  const { record, path } = buildAnchorRecord({
    root: { seqno: 12, rootHash: "deadbeef" },
    now,
    source: "https://example/api/log/2026-12/checkpoint",
    shard: "2026-12",
  });
  assert.equal(path, "anchors/2026/12/2026-12-01T010000Z-2026-12-000012.json");
  assert.equal(record.shard, "2026-12");
  assert.equal(record.seqno, 12);
});

test("buildSealedAnchorRecord produces anchors/sealed/<shard>.json with checkpoint body", () => {
  const rootHash = "a".repeat(64);
  const b64 = Buffer.from(rootHash, "hex").toString("base64");
  const body = `mypenny.ai/transparency-log/legacy\n100\n${b64}\n`;
  const cp = {
    format: "mypenny-checkpoint/v0",
    origin: "mypenny.ai/transparency-log/legacy",
    shard: "legacy",
    size: 100,
    rootHash,
    sealed: true,
    sealedAt: 1796083200000,
    successor: "2026-12",
    body,
  };
  const { record, path } = buildSealedAnchorRecord({
    checkpoint: cp,
    now: Date.parse("2026-12-01T00:05:00.000Z"),
    source: "https://example/api/log/legacy/checkpoint",
  });
  assert.equal(path, "anchors/sealed/legacy.json");
  assert.equal(record.shard, "legacy");
  assert.equal(record.seqno, 100);
  assert.equal(record.size, 100);
  assert.equal(record.sealed, true);
  assert.equal(record.body, body);
  assert.equal(record.capturedAt, "2026-12-01T00:05:00.000Z");
});
