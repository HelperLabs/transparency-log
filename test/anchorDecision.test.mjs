// test/anchorDecision.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoot, decideAnchor, buildAnchorRecord } from "../scripts/lib/anchorDecision.mjs";

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
