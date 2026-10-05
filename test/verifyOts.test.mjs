// test/verifyOts.test.mjs
// End-to-end checks of scripts/verify-ots.mjs on a scratch tree. Only the
// pending-proof paths are covered here: verifying a COMPLETE proof asks a
// Bitcoin block explorer, which an offline test must not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL("../scripts/verify-ots.mjs", import.meta.url));
const PENDING = readFileSync(join(dirname(require.resolve("opentimestamps/package.json")), "examples", "incomplete.txt.ots"));
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function run(files) {
  const cwd = mkdtempSync(join(tmpdir(), "tlog-verify-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), content);
    }
    const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("verify-ots: no proofs at all passes", () => {
  const r = run({ "snapshots/README.md": "x" });
  assert.equal(r.code, 0, r.err);
});

test("verify-ots: a recently stamped pending snapshot proof is skipped, not failed", () => {
  const r = run({
    "snapshots/2026-06-14.json": JSON.stringify({ timestamp: ago(DAY) }),
    "snapshots/2026-06-14.json.ots": PENDING,
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /skip \(pending/);
});

test("verify-ots: a snapshot proof still pending past 7 days fails", () => {
  const r = run({
    "snapshots/2026-06-14.json": JSON.stringify({ timestamp: ago(8 * DAY) }),
    "snapshots/2026-06-14.json.ots": PENDING,
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /snapshots\/2026-06-14\.json\.ots/);
  assert.match(r.err, /pending/);
});

test("verify-ots: an anchor proof still pending past 7 days fails (capturedAt)", () => {
  const r = run({
    "anchors/2026/06/a.json": JSON.stringify({ capturedAt: ago(8 * DAY) }),
    "anchors/2026/06/a.json.ots": PENDING,
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /pending/);
});

test("verify-ots: a pending proof whose source has no readable time fails closed", () => {
  const r = run({
    "snapshots/2026-06-14.json": JSON.stringify({ seqno: 1 }),
    "snapshots/2026-06-14.json.ots": PENDING,
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot bound/);
});

test("verify-ots: a pending proof whose source is not JSON fails closed", () => {
  const r = run({
    "snapshots/2026-06-14.json": "not json",
    "snapshots/2026-06-14.json.ots": PENDING,
  });
  assert.equal(r.code, 1);
});

test("verify-ots: a missing source file still fails", () => {
  const r = run({ "snapshots/2026-06-14.json.ots": PENDING });
  assert.equal(r.code, 1);
  assert.match(r.err, /missing/);
});
