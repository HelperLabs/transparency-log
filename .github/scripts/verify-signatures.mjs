// Verifies keys.json shape and every snapshot signature in snapshots/.
// Run by .github/workflows/verify-snapshot.yml on each push/PR.
import { readFileSync, readdirSync } from "node:fs";
import { webcrypto } from "node:crypto";
import * as ed from "@noble/ed25519";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const HEX64 = /^[0-9a-f]{64}$/;
let failures = 0;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failures++;
};

// --- keys.json ---
const keysDoc = JSON.parse(readFileSync("keys.json", "utf8"));
if (keysDoc.version !== 1) fail("keys.json: unsupported version");
const keys = new Map();
for (const k of keysDoc.keys ?? []) {
  if (k.algorithm !== "ed25519") fail(`keys.json: ${k.owner}: unsupported algorithm`);
  if (!HEX64.test(k.publicKeyHex ?? "")) fail(`keys.json: ${k.owner}: publicKeyHex is not 64-char hex`);
  if (!k.validFrom) fail(`keys.json: ${k.owner}: missing validFrom`);
  keys.set(k.owner, k);
}
if (keys.size === 0) fail("keys.json: no keys");
console.log(`keys.json: ${keys.size} key(s): ${[...keys.keys()].join(", ")}`);

// --- snapshots/*.json ---
const files = readdirSync("snapshots").filter((f) => f.endsWith(".json"));
for (const f of files) {
  const snap = JSON.parse(readFileSync(`snapshots/${f}`, "utf8"));
  if (!Number.isInteger(snap.seqno) || snap.seqno < 0) fail(`${f}: bad seqno`);
  if (!HEX64.test(snap.rootHash ?? "")) fail(`${f}: rootHash is not 64-char hex`);
  if (Number.isNaN(Date.parse(snap.timestamp ?? ""))) fail(`${f}: bad timestamp`);
  // Same bytes as signedPayload() in scripts/lib/snapshotCore.mjs: the
  // domain-separation tag, then seqno, rootHash and timestamp one per line.
  const payload = new TextEncoder().encode(`mypenny-tlog-snapshot-v1\n${snap.seqno}\n${snap.rootHash}\n${snap.timestamp}`);

  const sigs = snap.signatures ?? [];
  if (sigs.length === 0) fail(`${f}: no signatures`);
  for (const s of sigs) {
    const key = keys.get(s.owner);
    if (!key) {
      fail(`${f}: signature from unknown owner "${s.owner}"`);
      continue;
    }
    const ts = Date.parse(snap.timestamp);
    if (ts < Date.parse(key.validFrom) || (key.validUntil && ts > Date.parse(key.validUntil))) {
      fail(`${f}: ${s.owner}'s key not valid at snapshot timestamp`);
    }
    let sigBytes;
    try {
      sigBytes = Uint8Array.from(atob(s.signature), (c) => c.charCodeAt(0));
    } catch {
      fail(`${f}: ${s.owner}: signature is not valid base64`);
      continue;
    }
    if (sigBytes.length !== 64) {
      fail(`${f}: ${s.owner}: signature decodes to ${sigBytes.length} bytes, expected 64`);
      continue;
    }
    const pubBytes = Uint8Array.from(key.publicKeyHex.match(/../g), (h) => parseInt(h, 16));
    const ok = await ed.verifyAsync(sigBytes, payload, pubBytes);
    if (ok) console.log(`${f}: ${s.owner}: signature OK`);
    else fail(`${f}: ${s.owner}: signature INVALID`);
  }
}
if (files.length === 0) console.log("snapshots/: none yet (OK pre-launch)");

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All checks passed.");
