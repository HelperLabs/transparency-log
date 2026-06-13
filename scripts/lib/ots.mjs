// scripts/lib/ots.mjs
import O from "javascript-opentimestamps";
const { DetachedTimestampFile, Ops } = O;

/** Stamp raw file bytes; returns the .ots proof bytes (Uint8Array). */
export async function stampBytes(fileBytes) {
  const detached = DetachedTimestampFile.fromBytes(new Ops.OpSHA256(), fileBytes);
  await O.stamp(detached);
  return detached.serializeToBytes();
}

/** Upgrade a .ots; returns { bytes, changed }. bytes is the (possibly new) proof. */
export async function upgradeOts(otsBytes) {
  const detached = DetachedTimestampFile.deserialize([...otsBytes]);
  const changed = await O.upgrade(detached);
  return { bytes: detached.serializeToBytes(), changed };
}

/** True once a Bitcoin attestation is present (i.e. no longer pending). */
export function isComplete(otsBytes) {
  const detached = DetachedTimestampFile.deserialize([...otsBytes]);
  const info = O.info(detached);
  return /Bitcoin/i.test(info) && !/pending/i.test(info);
}

/** Verify a .ots against the original file bytes; returns the verify result object. */
export async function verifyOts(otsBytes, fileBytes) {
  const detachedOts = DetachedTimestampFile.deserialize([...otsBytes]);
  const detachedFile = DetachedTimestampFile.fromBytes(new Ops.OpSHA256(), fileBytes);
  return O.verify(detachedOts, detachedFile);
}
