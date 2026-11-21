// test/ots.test.mjs
// Offline tests for the OTS wrapper, run against the example proofs that ship
// inside the `opentimestamps` npm package. Nothing here touches a calendar or
// a block explorer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import O from "opentimestamps";
import { isComplete, verifyOts } from "../scripts/lib/ots.mjs";

const require = createRequire(import.meta.url);
const EXAMPLES = join(dirname(require.resolve("opentimestamps/package.json")), "examples");
const example = (name) => readFileSync(join(EXAMPLES, name));

test("isComplete: fully Bitcoin-attested proof is complete", () => {
  assert.equal(isComplete(example("hello-world.txt.ots")), true);
});

test("isComplete: proof with only pending attestations is not complete", () => {
  assert.equal(isComplete(example("incomplete.txt.ots")), false);
  assert.equal(isComplete(example("two-calendars.txt.ots")), false);
});

test("isComplete: upgraded multi-calendar proof with leftover pending attestations is complete", () => {
  // osdsp.txt.ots holds a Bitcoin block header attestation AND pending
  // attestations from calendars that had not been merged out. Timestamp.merge
  // only ever adds attestations, so this is the normal state of an upgraded
  // proof. A regex that rejects any mention of "pending" gets it wrong.
  const bytes = example("osdsp.txt.ots");
  const info = O.info(O.DetachedTimestampFile.deserialize([...bytes]));
  assert.match(info, /BitcoinBlockHeaderAttestation/, "fixture should carry a Bitcoin attestation");
  assert.match(info, /pending/i, "fixture should also carry a leftover pending attestation");
  assert.equal(isComplete(bytes), true);
});

test("isComplete: a pending proof becomes complete once a Bitcoin attestation is merged in", () => {
  const detached = O.DetachedTimestampFile.deserialize([...example("incomplete.txt.ots")]);
  assert.equal(isComplete(detached.serializeToBytes()), false);
  detached.timestamp.attestations.push(new O.Notary.BitcoinBlockHeaderAttestation(358391));
  const bytes = detached.serializeToBytes();
  assert.match(O.info(O.DetachedTimestampFile.deserialize([...bytes])), /pending/i); // pending is still there
  assert.equal(isComplete(bytes), true);
});

test("verifyOts: verifies digest + Bitcoin attestation, caches block headers, and fails over on 429", async () => {
  const otsBytes = example("hello-world.txt.ots");
  const fileBytes = example("hello-world.txt");
  const detached = O.DetachedTimestampFile.deserialize([...otsBytes]);
  let expectedHeight;
  let expectedMerkle;
  detached.timestamp.allAttestations().forEach((att, msg) => {
    if (att instanceof O.Notary.BitcoinBlockHeaderAttestation) {
      expectedHeight = att.height;
      expectedMerkle = Buffer.from(msg.slice().reverse()).toString("hex");
    }
  });
  assert.ok(expectedHeight && expectedMerkle);

  const calls = [];
  const fakeHash = "b".repeat(64);
  const fetchFn = async (url) => {
    calls.push(url);
    // Primary returns 429; secondary answers with the block header.
    if (url.startsWith("https://primary.test")) return { ok: false, status: 429, text: async () => "rate limited" };
    if (url.endsWith(`/block-height/${expectedHeight}`)) return { ok: true, status: 200, text: async () => fakeHash };
    if (url.endsWith(`/block/${fakeHash}`)) {
      return { ok: true, status: 200, json: async () => ({ merkle_root: expectedMerkle, timestamp: 1432827678 }) };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const blockCache = new Map();
  const opts = { esploraUrls: ["https://primary.test", "https://backup.test"], fetchFn, blockCache };
  const res1 = await verifyOts(otsBytes, fileBytes, opts);
  assert.deepEqual(res1, { bitcoin: { timestamp: 1432827678, height: expectedHeight } });
  const callsAfterFirst = calls.length;

  // Second call for the same height hits the cache (zero new HTTP calls).
  const res2 = await verifyOts(otsBytes, fileBytes, opts);
  assert.deepEqual(res2, res1);
  assert.equal(calls.length, callsAfterFirst);

  // Wrong source bytes fail closed before any explorer call.
  await assert.rejects(verifyOts(otsBytes, Buffer.from("tampered"), opts), /does not match/);

  // Wrong merkle_root from explorer fails verification.
  const badFetch = async (url) => {
    if (url.endsWith(`/block-height/${expectedHeight}`)) return { ok: true, status: 200, text: async () => fakeHash };
    return { ok: true, status: 200, json: async () => ({ merkle_root: "0".repeat(64), timestamp: 1432827678 }) };
  };
  await assert.rejects(
    verifyOts(otsBytes, fileBytes, { esploraUrls: ["https://bad.test"], fetchFn: badFetch, blockCache: new Map() }),
    /merkleroot/i,
  );
});
