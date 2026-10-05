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
import { isComplete } from "../scripts/lib/ots.mjs";

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
