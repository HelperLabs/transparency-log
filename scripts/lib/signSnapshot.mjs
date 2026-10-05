// scripts/lib/signSnapshot.mjs
// The founder signing flow, with the key, the stamper and the live root passed
// in so it can run offline in tests. scripts/sign-snapshot.mjs is the thin CLI.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { signedPayload, checkMonotonic, snapshotPath, canonicalToSign, applySignature } from "./snapshotCore.mjs";

function latestSnapshot(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? JSON.parse(readFileSync(`${dir}/${files.at(-1)}`, "utf8")) : null;
}

/**
 * Sign (or co-sign) today's snapshot and stamp it.
 *   live   - { seqno, rootHash } as returned by the log worker
 *   now    - ms since the epoch
 *   sign   - async (payloadString) => base64 Ed25519 signature
 *   stamp  - async (fileBytes) => .ots proof bytes
 * Returns { path, record }.
 */
export async function signSnapshot({ dir = "snapshots", live, now, owner, sign, stamp }) {
  const { seqno, rootHash } = live;
  if (!rootHash) throw new Error("log is empty; nothing to sign");
  const timestamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");

  const gate = checkMonotonic(latestSnapshot(dir), { seqno, timestamp });
  if (!gate.ok) throw new Error(`monotonicity sanity-gate FAILED: ${gate.reason} — refusing to sign`);

  // Co-sign if today's snapshot already exists (the other founder signed first).
  const path = snapshotPath(timestamp, dir);
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const canonical = canonicalToSign(existing, { seqno, rootHash, timestamp });

  const signatureB64 = await sign(signedPayload(canonical));
  const record = applySignature(existing, canonical, owner, signatureB64);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");

  // Stamp the signed snapshot (re-stamping on co-sign is needed: the file changed).
  writeFileSync(`${path}.ots`, await stamp(readFileSync(path)));
  return { path, record };
}
