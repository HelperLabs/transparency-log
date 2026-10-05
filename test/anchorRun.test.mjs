// test/anchorRun.test.mjs
// The hourly anchor run, offline: the root fetch, the stamper and the upgrader
// are injected, so nothing here reaches the log worker or an OTS calendar.
// Each test runs in a scratch directory (node --test gives every file its own
// process, and tests in a file run one at a time, so chdir is safe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAnchor } from "../scripts/lib/anchorRun.mjs";
import { isComplete } from "../scripts/lib/ots.mjs";

const require = createRequire(import.meta.url);
const PENDING_OTS = readFileSync(join(dirname(require.resolve("opentimestamps/package.json")), "examples", "incomplete.txt.ots"));
const ANCHOR_SCRIPT = fileURLToPath(new URL("../scripts/anchor.mjs", import.meta.url));
const H = "c".repeat(64);
const NOW = Date.parse("2026-10-04T12:00:00.000Z");

/** Run `fn` in a fresh scratch dir; returns whatever fn returns. */
async function inScratch(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "tlog-anchor-"));
  const prev = process.cwd();
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  process.chdir(dir);
  try { return await fn(dir); }
  finally { process.chdir(prev); rmSync(dir, { recursive: true, force: true }); }
}

const rootResponse = (body, ok = true, status = 200) => async () => ({ ok, status, text: async () => JSON.stringify(body) });

function deps(overrides = {}) {
  const calls = { stamp: 0, upgrade: 0 };
  const d = {
    rootUrl: "https://example.test/api/log/root",
    now: NOW,
    isComplete,
    fetchFn: rootResponse({ seqno: 7, rootHash: H }),
    stamp: async () => { calls.stamp++; return Uint8Array.from([9, 9, 9]); },
    upgrade: async (bytes) => { calls.upgrade++; return { bytes, changed: false }; },
    log: () => {},
    ...overrides,
  };
  return { d, calls };
}

const snapshot = (dir) => {
  const out = [];
  const walk = (p) => readdirSync(p, { withFileTypes: true }).forEach((e) =>
    e.isDirectory() ? walk(join(p, e.name)) : out.push(join(p, e.name).slice(dir.length + 1)));
  walk(dir);
  return out.sort();
};

test("dry run: decides and prints what it would anchor, but stamps nothing and writes nothing", async () => {
  await inScratch({}, async (dir) => {
    const lines = [];
    const { d, calls } = deps({ dryRun: true, log: (l) => lines.push(l) });
    const r = await runAnchor(d);
    assert.equal(r.action, "would-anchor");
    assert.equal(calls.stamp, 0);
    assert.equal(calls.upgrade, 0);
    assert.deepEqual(snapshot(dir), []);          // no record, no .ots, no pending.json, no latest.json
    const out = lines.join("\n");
    assert.match(out, /dry run/i);
    assert.match(out, /would anchor anchors\/2026\/10\/2026-10-04T120000Z-000007\.json/);
    assert.match(out, new RegExp(H));              // shows the record it would stamp
  });
});

test("dry run: a skip decision is reported and still writes nothing", async () => {
  const latest = JSON.stringify({ seqno: 7, rootHash: H, capturedAt: new Date(NOW - 3600_000).toISOString(), file: "x" });
  await inScratch({ "anchors/latest.json": latest }, async (dir) => {
    const lines = [];
    const { d } = deps({ dryRun: true, log: (l) => lines.push(l) });
    const r = await runAnchor(d);
    assert.equal(r.action, "skipped");
    assert.deepEqual(snapshot(dir), ["anchors/latest.json"]);
    assert.equal(readFileSync(join(dir, "anchors/latest.json"), "utf8"), latest);
    assert.match(lines.join("\n"), /unchanged within heartbeat/);
  });
});

test("dry run: lists incomplete proofs it would upgrade without contacting a calendar or touching them", async () => {
  await inScratch({ "snapshots/2026-06-14.json.ots": PENDING_OTS }, async (dir) => {
    const lines = [];
    const { d, calls } = deps({ dryRun: true, log: (l) => lines.push(l) });
    await runAnchor(d);
    assert.equal(calls.upgrade, 0);
    assert.deepEqual(readFileSync(join(dir, "snapshots/2026-06-14.json.ots")), PENDING_OTS);
    assert.match(lines.join("\n"), /would upgrade 1 incomplete proof.*snapshots\/2026-06-14\.json\.ots/s);
  });
});

test("dry run: an empty log is reported, nothing written", async () => {
  await inScratch({}, async (dir) => {
    const { d } = deps({ dryRun: true, fetchFn: rootResponse({ seqno: 0, rootHash: "" }) });
    const r = await runAnchor(d);
    assert.equal(r.action, "skipped");
    assert.deepEqual(snapshot(dir), []);
  });
});

test("real run (stamper faked): writes record, proof, pending and latest together", async () => {
  await inScratch({}, async (dir) => {
    const { d, calls } = deps();
    const r = await runAnchor(d);
    assert.equal(r.action, "anchored");
    assert.equal(calls.stamp, 1);
    const path = "anchors/2026/10/2026-10-04T120000Z-000007.json";
    assert.deepEqual(snapshot(dir), [path, `${path}.ots`, "anchors/latest.json", "anchors/pending.json"].sort());
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "anchors/pending.json"), "utf8")), [`${path}.ots`]);
    assert.equal(JSON.parse(readFileSync(join(dir, "anchors/latest.json"), "utf8")).rootHash, H);
  });
});

test("real run: a stamp failure is a soft skip and leaves no orphaned record", async () => {
  await inScratch({}, async (dir) => {
    const { d } = deps({ stamp: async () => { throw new Error("calendar down"); } });
    const r = await runAnchor(d);
    assert.equal(r.action, "stamp-failed");
    assert.deepEqual(snapshot(dir), ["anchors/pending.json"]);
  });
});

test("real run: a failed root fetch skips the anchor", async () => {
  await inScratch({}, async (dir) => {
    const { d, calls } = deps({ fetchFn: rootResponse({}, false, 503) });
    const r = await runAnchor(d);
    assert.equal(r.action, "root-fetch-failed");
    assert.equal(calls.stamp, 0);
  });
});

test("real run: snapshot proofs are upgraded in the same run", async () => {
  await inScratch({ "snapshots/2026-06-14.json.ots": PENDING_OTS }, async (dir) => {
    const done = readFileSync(join(dirname(require.resolve("opentimestamps/package.json")), "examples", "hello-world.txt.ots"));
    const { d, calls } = deps({ upgrade: async () => ({ bytes: done, changed: true }) });
    await runAnchor(d);
    assert.deepEqual(readFileSync(join(dir, "snapshots/2026-06-14.json.ots")), done);
    assert.equal(calls.stamp, 1);
  });
});

test("CLI: node scripts/anchor.mjs --dry-run against a local root writes nothing", async () => {
  const server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ seqno: 12, rootHash: H })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), "tlog-anchor-cli-"));
  try {
    // spawnSync would block the event loop and starve the server; use async spawn.
    const child = spawn(process.execPath, [ANCHOR_SCRIPT, "--dry-run"], {
      cwd: dir, env: { ...process.env, ROOT_URL: `http://127.0.0.1:${port}/api/log/root` },
    });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (err += c));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, err);
    assert.match(out, /would anchor anchors\/\d{4}\/\d{2}\/.*-000012\.json/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: an unknown flag (say, a mistyped --dry-run) is refused instead of running for real", async () => {
  // The server reports an empty log, so even if the guard were missing the run
  // would skip before stamping anything.
  const server = createServer((req, res) => res.end(JSON.stringify({ seqno: 0, rootHash: "" })));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), "tlog-anchor-cli-"));
  try {
    for (const flag of ["--dryrun", "--dry_run", "dry-run"]) {
      const child = spawn(process.execPath, [ANCHOR_SCRIPT, flag], {
        cwd: dir, env: { ...process.env, ROOT_URL: `http://127.0.0.1:${port}/api/log/root` },
      });
      let err = "";
      child.stderr.on("data", (c) => (err += c));
      const code = await new Promise((r) => child.on("close", r));
      assert.equal(code, 2, flag);
      assert.match(err, /usage/i, flag);
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
