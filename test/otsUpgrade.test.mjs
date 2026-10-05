// test/otsUpgrade.test.mjs
// The hourly upgrade loop must cover snapshot proofs, not just the proofs
// registered in anchors/pending.json. Offline: `upgrade` is injected, so no
// calendar is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { findOtsFiles, upgradeProofs } from "../scripts/lib/otsUpgrade.mjs";
import { isComplete } from "../scripts/lib/ots.mjs";

const require = createRequire(import.meta.url);
const EXAMPLES = join(dirname(require.resolve("opentimestamps/package.json")), "examples");
const PENDING = readFileSync(join(EXAMPLES, "incomplete.txt.ots"));
const COMPLETE = readFileSync(join(EXAMPLES, "hello-world.txt.ots"));

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "tlog-upg-"));
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), bytes);
  }
  return root;
}

/** Fake upgrade: counts calls and returns a canned result. */
function fakeUpgrade(result) {
  const calls = [];
  const fn = async (bytes) => { calls.push(bytes); return result; };
  fn.calls = calls;
  return fn;
}

test("findOtsFiles: recurses, returns only .ots files, sorted; missing dir is empty", () => {
  const root = tree({
    "snapshots/2026-06-14.json": "{}",
    "snapshots/2026-06-14.json.ots": PENDING,
    "snapshots/archive/2025/2025-12-01.json.ots": PENDING,
    "snapshots/README.md": "x",
  });
  try {
    assert.deepEqual(
      findOtsFiles([join(root, "snapshots"), join(root, "nope")]),
      [join(root, "snapshots/2026-06-14.json.ots"), join(root, "snapshots/archive/2025/2025-12-01.json.ots")],
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgradeProofs: a pending snapshot proof found by scan is upgraded and written back", async () => {
  const root = tree({ "snapshots/2026-06-14.json.ots": PENDING });
  const path = join(root, "snapshots/2026-06-14.json.ots");
  const upgrade = fakeUpgrade({ bytes: COMPLETE, changed: true });
  try {
    const r = await upgradeProofs({ pending: [], scanDirs: [join(root, "snapshots")], upgrade, isComplete });
    assert.equal(upgrade.calls.length, 1);
    assert.deepEqual(readFileSync(path), COMPLETE);
    assert.deepEqual(r.completed, [path]);
    assert.deepEqual(r.pending, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgradeProofs: without scanDirs a snapshot proof is never touched (the original bug)", async () => {
  const root = tree({ "snapshots/2026-06-14.json.ots": PENDING });
  const upgrade = fakeUpgrade({ bytes: COMPLETE, changed: true });
  try {
    await upgradeProofs({ pending: [], scanDirs: [], upgrade, isComplete });
    assert.equal(upgrade.calls.length, 0);
    assert.deepEqual(readFileSync(join(root, "snapshots/2026-06-14.json.ots")), PENDING);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgradeProofs: an already-complete proof is skipped without contacting a calendar", async () => {
  const root = tree({ "snapshots/2026-06-14.json.ots": COMPLETE });
  const upgrade = fakeUpgrade({ bytes: COMPLETE, changed: false });
  try {
    const r = await upgradeProofs({ pending: [], scanDirs: [join(root, "snapshots")], upgrade, isComplete });
    assert.equal(upgrade.calls.length, 0);
    assert.deepEqual(r.completed, []); // nothing newly completed, so nothing to log or commit
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgradeProofs: a proof that is still pending after upgrade stays pending and unwritten", async () => {
  const root = tree({ "anchors/2026/06/a.json.ots": PENDING });
  const path = join(root, "anchors/2026/06/a.json.ots");
  const upgrade = fakeUpgrade({ bytes: PENDING, changed: false });
  try {
    const r = await upgradeProofs({ pending: [path], scanDirs: [], upgrade, isComplete });
    assert.deepEqual(r.pending, [path]);
    assert.deepEqual(r.completed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgradeProofs: tracked pending proofs still upgrade and drain from the list", async () => {
  const root = tree({ "anchors/2026/06/a.json.ots": PENDING });
  const path = join(root, "anchors/2026/06/a.json.ots");
  const upgrade = fakeUpgrade({ bytes: COMPLETE, changed: true });
  try {
    const r = await upgradeProofs({ pending: [path, join(root, "anchors/gone.json.ots")], scanDirs: [], upgrade, isComplete });
    assert.deepEqual(r.pending, []); // completed one drained, vanished one dropped
    assert.deepEqual(readFileSync(path), COMPLETE);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgradeProofs: a proof listed in pending and found by scan is upgraded once", async () => {
  const root = tree({ "snapshots/2026-06-14.json.ots": PENDING });
  const path = join(root, "snapshots/2026-06-14.json.ots");
  const upgrade = fakeUpgrade({ bytes: COMPLETE, changed: true });
  try {
    await upgradeProofs({ pending: [path], scanDirs: [join(root, "snapshots")], upgrade, isComplete });
    assert.equal(upgrade.calls.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgradeProofs: one broken proof does not stop the others", async () => {
  const root = tree({
    "snapshots/2026-06-07.json.ots": Buffer.from("not an ots file"),
    "snapshots/2026-06-14.json.ots": PENDING,
  });
  const good = join(root, "snapshots/2026-06-14.json.ots");
  const bad = join(root, "snapshots/2026-06-07.json.ots");
  const upgrade = fakeUpgrade({ bytes: COMPLETE, changed: true });
  try {
    const r = await upgradeProofs({ pending: [], scanDirs: [join(root, "snapshots")], upgrade, isComplete });
    assert.deepEqual(r.failed, [bad]);
    assert.deepEqual(r.completed, [good]);
    assert.deepEqual(readFileSync(good), COMPLETE);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
