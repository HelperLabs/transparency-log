// test/signSnapshot.test.mjs
// The founder signing flow, end to end on a scratch directory: real Ed25519
// keys, a fake stamper (nothing touches a calendar), and a live root passed in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { signSnapshot } from "../scripts/lib/signSnapshot.mjs";
import { signedPayload } from "../scripts/lib/snapshotCore.mjs";

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
