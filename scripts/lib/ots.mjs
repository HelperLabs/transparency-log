// scripts/lib/ots.mjs
import O from "opentimestamps";
const { DetachedTimestampFile, Ops, Notary, Utils } = O;

const HEX64 = /^[0-9a-f]{64}$/;
export const DEFAULT_ESPLORA_URLS = [
  "https://blockstream.info/api",
  "https://mempool.space/api",
];

// Shared across verifyOts() calls in one process so repeated heights across
// multiple proofs (and multiple calendar attestations per proof) only query
// the block explorer once.
const defaultBlockCache = new Map();

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

/**
 * True once the proof carries an attestation beyond a calendar's pending
 * promise, using the library's own predicate (it counts Bitcoin, Litecoin and
 * unrecognized attestations). Do not regex the info() text: Timestamp.merge
 * only ever adds attestations, so an upgraded proof still lists the
 * calendars' original pending attestations next to the Bitcoin one.
 */
export function isComplete(otsBytes) {
  const detached = DetachedTimestampFile.deserialize([...otsBytes]);
  return detached.timestamp.isTimestampComplete();
}

async function fetchEsploraBlock(height, { esploraUrls, fetchFn, timeoutMs }) {
  const errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const rawBase of esploraUrls) {
      const base = rawBase.replace(/\/+$/, "");
      try {
        const hashRes = await fetchFn(`${base}/block-height/${height}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!hashRes.ok) {
          errors.push(`${base} block-height ${hashRes.status}`);
          continue;
        }
        const blockHash = (await hashRes.text()).trim();
        if (!HEX64.test(blockHash)) {
          errors.push(`${base} invalid block hash`);
          continue;
        }
        const blockRes = await fetchFn(`${base}/block/${blockHash}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!blockRes.ok) {
          errors.push(`${base} block ${blockRes.status}`);
          continue;
        }
        const block = await blockRes.json();
        if (typeof block?.merkle_root !== "string" || !HEX64.test(block.merkle_root) || typeof block?.timestamp !== "number") {
          errors.push(`${base} invalid block header`);
          continue;
        }
        return { merkleroot: block.merkle_root, time: block.timestamp };
      } catch (err) {
        errors.push(`${base} ${err?.message ?? err}`);
      }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`bitcoin block ${height} lookup failed (${errors.join("; ")})`);
}

async function getBlockHeader(height, opts) {
  const cache = opts.blockCache ?? defaultBlockCache;
  if (!cache.has(height)) {
    const p = fetchEsploraBlock(height, opts).catch((err) => {
      cache.delete(height);
      throw err;
    });
    cache.set(height, p);
  }
  return cache.get(height);
}

/**
 * Verify a complete .ots against the original file bytes.
 *
 * Verifies the file digest and every BitcoinBlockHeaderAttestation in the
 * proof directly against cached Esplora block headers (with failover across
 * public explorers on 429/5xx), avoiding O.verify()'s uncached per-attestation
 * requests and redundant calendar upgrade calls that trip Blockstream's rate
 * limit once a repo holds dozens of anchors.
 */
export async function verifyOts(otsBytes, fileBytes, options = {}) {
  const detachedOts = DetachedTimestampFile.deserialize([...otsBytes]);
  const detachedFile = DetachedTimestampFile.fromBytes(new Ops.OpSHA256(), fileBytes);
  if (!Utils.arrEq(detachedOts.fileDigest(), detachedFile.fileDigest())) {
    throw new Error("File does not match original!");
  }

  const bitcoinAttestations = [];
  detachedOts.timestamp.allAttestations().forEach((attestation, msg) => {
    if (attestation instanceof Notary.BitcoinBlockHeaderAttestation) {
      bitcoinAttestations.push({ attestation, msg });
    }
  });

  if (bitcoinAttestations.length === 0) {
    return O.verifyTimestamp(detachedOts.timestamp, { ignoreBitcoinNode: true });
  }

  const esploraUrls = options.esploraUrls
    ?? (process.env.ESPLORA_URL ? [process.env.ESPLORA_URL] : DEFAULT_ESPLORA_URLS);
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const blockCache = options.blockCache ?? defaultBlockCache;

  let earliest = null;
  for (const { attestation, msg } of bitcoinAttestations) {
    const header = await getBlockHeader(attestation.height, { esploraUrls, fetchFn, timeoutMs, blockCache });
    const attestedTime = attestation.verifyAgainstBlockheader(msg.slice().reverse(), header);
    if (!earliest || attestedTime < earliest.timestamp) {
      earliest = { timestamp: attestedTime, height: attestation.height };
    }
  }
  return earliest ? { bitcoin: earliest } : {};
}
