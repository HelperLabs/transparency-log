// test/otsState.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { addPending, removeCompleted, MAX_PENDING_MS, recordTime, pendingVerdict } from "../scripts/lib/otsState.mjs";

test("addPending appends unique paths, preserving order", () => {
  assert.deepEqual(addPending(["a"], "b"), ["a", "b"]);
  assert.deepEqual(addPending(["a", "b"], "b"), ["a", "b"]); // idempotent
  assert.deepEqual(addPending([], "a"), ["a"]);
});

test("removeCompleted drops exactly the completed paths", () => {
  assert.deepEqual(removeCompleted(["a", "b", "c"], new Set(["b"])), ["a", "c"]);
  assert.deepEqual(removeCompleted(["a", "b"], new Set(["a", "b"])), []);
  assert.deepEqual(removeCompleted(["a"], new Set()), ["a"]);
});

// --- bounded pending age ---------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-20T00:00:00Z");

test("MAX_PENDING_MS is 7 days", () => {
  assert.equal(MAX_PENDING_MS, 7 * DAY);
});

test("recordTime reads capturedAt (anchors) or timestamp (snapshots), else null", () => {
  assert.equal(recordTime({ capturedAt: "2026-06-13T15:00:11.500Z" }), Date.parse("2026-06-13T15:00:11.500Z"));
  assert.equal(recordTime({ timestamp: "2026-06-14T00:00:00Z" }), Date.parse("2026-06-14T00:00:00Z"));
  assert.equal(recordTime({}), null);
  assert.equal(recordTime({ timestamp: "garbage" }), null);
  assert.equal(recordTime(null), null);
});

test("pendingVerdict: a proof pending within the limit is ok", () => {
  const v = pendingVerdict({ record: { timestamp: "2026-06-14T00:00:00Z" }, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.ageMs, 6 * DAY);
});

test("pendingVerdict: a proof pending past the limit fails and says how long", () => {
  const v = pendingVerdict({ record: { timestamp: "2026-06-12T00:00:00Z" }, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /8 days/);
});

test("pendingVerdict: exactly at the limit is still ok; one millisecond over is not", () => {
  const atLimit = new Date(NOW - MAX_PENDING_MS).toISOString();
  assert.equal(pendingVerdict({ record: { timestamp: atLimit }, now: NOW }).ok, true);
  assert.equal(pendingVerdict({ record: { timestamp: atLimit }, now: NOW + 1 }).ok, false);
});

test("pendingVerdict: a record with no readable time fails closed", () => {
  const v = pendingVerdict({ record: { seqno: 1 }, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /cannot bound/);
});

test("pendingVerdict: honors a custom limit", () => {
  const v = pendingVerdict({ record: { capturedAt: "2026-06-19T00:00:00Z" }, now: NOW, maxPendingMs: DAY / 2 });
  assert.equal(v.ok, false);
});
