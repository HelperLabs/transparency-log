// test/signSnapshot.test.mjs
// The founder signing flow, end to end on a scratch directory: real Ed25519
// keys, a fake stamper (nothing touches a calendar), and a live root passed in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { signSnapshot } from "../scripts/lib/signSnapshot.mjs";
import { signedPayload } from "../scripts/lib/snapshotCore.mjs";

const VERIFY = fileURLToPath(new URL("../.github/scripts/verify-signatures.mjs", import.meta.url));
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

async function founder() {
  const seed = ed.utils.randomPrivateKey();
  return { seed, pub: await ed.getPublicKeyAsync(seed) };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "tlog-sign-"));
  const stamps = [];
  const stamp = async (bytes) => { stamps.push(bytes); return Uint8Array.from([1, 2, 3]); };
  const signer = (seed) => async (payload) =>
    Buffer.from(await ed.signAsync(new TextEncoder().encode(payload), seed)).toString("base64");
  return { dir, stamps, stamp, signer, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const verifies = async (sigB64, payload, pub) =>
  ed.verifyAsync(Uint8Array.from(Buffer.from(sigB64, "base64")), new TextEncoder().encode(payload), pub);

test("first signer writes a single-signature snapshot and stamps it", async () => {
  const h = harness();
  try {
    const a = await founder();
    const { path, record } = await signSnapshot({
      dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp,
      live: { seqno: 100, rootHash: H1 }, now: Date.parse("2026-06-14T00:00:00Z"),
    });
    assert.equal(path, join(h.dir, "2026-06-14.json"));
    assert.deepEqual({ ...record, signatures: undefined }, { seqno: 100, rootHash: H1, timestamp: "2026-06-14T00:00:00Z", signatures: undefined });
    assert.equal(record.signatures.length, 1);
    assert.equal(h.stamps.length, 1);
    assert.ok(existsSync(`${path}.ots`));
  } finally { h.done(); }
});

test("second signer succeeds hours later even though the live log has grown", async () => {
  const h = harness();
  try {
    const a = await founder(), p = await founder();
    await signSnapshot({
      dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp,
      live: { seqno: 100, rootHash: H1 }, now: Date.parse("2026-06-14T00:00:00Z"),
    });
    // Peter signs 9 hours later. The log has moved on: new seqno, new root.
    const { record } = await signSnapshot({
      dir: h.dir, owner: "peter", sign: h.signer(p.seed), stamp: h.stamp,
      live: { seqno: 140, rootHash: H2 }, now: Date.parse("2026-06-14T09:00:00Z"),
    });
    // The file still states what Aaron signed, with both signatures on it.
    assert.equal(record.seqno, 100);
    assert.equal(record.rootHash, H1);
    assert.equal(record.timestamp, "2026-06-14T00:00:00Z");
    assert.deepEqual(record.signatures.map((s) => s.owner), ["aaron", "peter"]);
    // And both signatures verify against the one payload rebuilt from the file.
    const payload = signedPayload(record);
    assert.equal(await verifies(record.signatures[0].signature, payload, a.pub), true);
    assert.equal(await verifies(record.signatures[1].signature, payload, p.pub), true);
    assert.equal(h.stamps.length, 2); // re-stamped, because the file changed
  } finally { h.done(); }
});

test("co-signing refuses when the live log is behind what the file records", async () => {
  const h = harness();
  try {
    const a = await founder(), p = await founder();
    const first = await signSnapshot({
      dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp,
      live: { seqno: 100, rootHash: H1 }, now: Date.parse("2026-06-14T00:00:00Z"),
    });
    const before = readFileSync(first.path, "utf8");
    await assert.rejects(
      signSnapshot({
        dir: h.dir, owner: "peter", sign: h.signer(p.seed), stamp: h.stamp,
        live: { seqno: 90, rootHash: H2 }, now: Date.parse("2026-06-14T09:00:00Z"),
      }),
      /regress|behind/,
    );
    assert.equal(readFileSync(first.path, "utf8"), before);
    assert.equal(h.stamps.length, 1);
  } finally { h.done(); }
});

test("signer refuses worker output it could not have verified, and signs nothing", async () => {
  const h = harness();
  try {
    const a = await founder();
    let signed = 0;
    const sign = async (p) => { signed++; return h.signer(a.seed)(p); };
    const bad = [
      { seqno: 1, rootHash: "a\nb" },
      { seqno: "1\na", rootHash: "b" },
      { seqno: -5, rootHash: H1 },
      { seqno: 1.5, rootHash: H1 },
      { seqno: 1, rootHash: H1.toUpperCase() },
      { seqno: 1, rootHash: H1.slice(2) },
    ];
    for (const live of bad) {
      await assert.rejects(
        signSnapshot({ dir: h.dir, owner: "aaron", sign, stamp: h.stamp, live, now: Date.parse("2026-06-14T00:00:00Z") }),
        /root/, JSON.stringify(live));
    }
    assert.equal(signed, 0);
    assert.equal(h.stamps.length, 0);
    assert.equal(existsSync(join(h.dir, "2026-06-14.json")), false);
  } finally { h.done(); }
});

test("an empty log is still reported as empty, not as malformed", async () => {
  const h = harness();
  try {
    const a = await founder();
    await assert.rejects(
      signSnapshot({ dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp, live: { seqno: 0, rootHash: "" }, now: Date.now() }),
      /empty/);
  } finally { h.done(); }
});

test("a later snapshot with the same seqno but a different rootHash is refused (history rewrite)", async () => {
  const h = harness();
  try {
    const a = await founder();
    await signSnapshot({ dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp,
      live: { seqno: 100, rootHash: H1 }, now: Date.parse("2026-06-07T00:00:00Z") });
    await assert.rejects(
      signSnapshot({ dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp,
        live: { seqno: 100, rootHash: H2 }, now: Date.parse("2026-06-14T00:00:00Z") }),
      /rootHash/);
    assert.equal(existsSync(join(h.dir, "2026-06-14.json")), false);
  } finally { h.done(); }
});

test("a co-signer is refused when the live root is the same size as the file but a different hash", async () => {
  const h = harness();
  try {
    const a = await founder(), p = await founder();
    await signSnapshot({ dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp,
      live: { seqno: 100, rootHash: H1 }, now: Date.parse("2026-06-14T00:00:00Z") });
    await assert.rejects(
      signSnapshot({ dir: h.dir, owner: "peter", sign: h.signer(p.seed), stamp: h.stamp,
        live: { seqno: 100, rootHash: H2 }, now: Date.parse("2026-06-14T09:00:00Z") }),
      /rootHash/);
  } finally { h.done(); }
});

/** Run .github/scripts/verify-signatures.mjs on a scratch tree holding `snapshot` signed by `keys`. */
async function runVerifier(snapshot, keys) {
  const cwd = mkdtempSync(join(tmpdir(), "tlog-verifier-"));
  try {
    mkdirSync(join(cwd, "snapshots"));
    writeFileSync(join(cwd, "keys.json"), JSON.stringify({
      version: 1,
      keys: await Promise.all(Object.entries(keys).map(async ([owner, f]) => ({
        owner, algorithm: "ed25519", validFrom: "2020-01-01T00:00:00Z",
        publicKeyHex: Buffer.from(f.pub).toString("hex"),
      }))),
    }));
    writeFileSync(join(cwd, "snapshots", "2026-06-14.json"), JSON.stringify(snapshot));
    const r = spawnSync(process.execPath, [VERIFY], { cwd, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("lockstep: a snapshot made by the signer passes the CI verifier, both signatures", async () => {
  const h = harness();
  try {
    const a = await founder(), p = await founder();
    await signSnapshot({ dir: h.dir, owner: "aaron", sign: h.signer(a.seed), stamp: h.stamp,
      live: { seqno: 100, rootHash: H1 }, now: Date.parse("2026-06-14T00:00:00Z") });
    const { record } = await signSnapshot({ dir: h.dir, owner: "peter", sign: h.signer(p.seed), stamp: h.stamp,
      live: { seqno: 120, rootHash: H2 }, now: Date.parse("2026-06-14T09:00:00Z") });
    const r = await runVerifier(record, { aaron: a, peter: p });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /aaron: signature OK/);
    assert.match(r.out, /peter: signature OK/);
  } finally { h.done(); }
});

test("lockstep: a signature over the old untagged payload no longer verifies", async () => {
  const a = await founder();
  const snap = { seqno: 100, rootHash: H1, timestamp: "2026-06-14T00:00:00Z" };
  const untagged = `${snap.seqno}\n${snap.rootHash}\n${snap.timestamp}`;
  const sig = Buffer.from(await ed.signAsync(new TextEncoder().encode(untagged), a.seed)).toString("base64");
  const r = await runVerifier({ ...snap, signatures: [{ owner: "aaron", signature: sig }] }, { aaron: a });
  assert.equal(r.code, 1);
  assert.match(r.err, /signature INVALID/);
});
