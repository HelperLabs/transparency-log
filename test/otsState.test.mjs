// test/otsState.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { addPending, removeCompleted } from "../scripts/lib/otsState.mjs";

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
