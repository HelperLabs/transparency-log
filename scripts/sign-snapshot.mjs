// scripts/sign-snapshot.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { argv } from "node:process";
import * as ed from "@noble/ed25519";
import { signedPayload, checkMonotonic, buildSnapshotRecord, snapshotPath } from "./lib/snapshotCore.mjs";
import { stampBytes } from "./lib/ots.mjs";

const ROOT_URL = process.env.ROOT_URL
  ?? "https://mypenny-transparency-log.mypenny.workers.dev/api/log/root";

function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Load a 32-byte ed25519 seed from a PEM (PKCS#8) or 64-hex-char file. */
function loadSeed(keyPath) {
  const raw = readFileSync(keyPath, "utf8").trim();
  if (raw.includes("BEGIN PRIVATE KEY")) {
    const b64 = raw.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const der = Buffer.from(b64, "base64");
    return new Uint8Array(der.subarray(der.length - 32)); // PKCS#8 ed25519 seed is the trailing 32 bytes
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(raw.match(/../g).map((h) => parseInt(h, 16)));
  throw new Error("unrecognized key format (expect PKCS#8 PEM or 64-hex seed)");
}

function latestSnapshot() {
  if (!existsSync("snapshots")) return null;
  const files = readdirSync("snapshots").filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? JSON.parse(readFileSync(`snapshots/${files.at(-1)}`, "utf8")) : null;
}

async function main() {
  const owner = arg("owner");
  const keyPath = arg("key");
  if (!owner || !keyPath) throw new Error("usage: sign-snapshot.mjs --owner <name> --key <path>");

  const res = await fetch(ROOT_URL);
  if (!res.ok) throw new Error(`root fetch ${res.status}`);
  const { seqno, rootHash } = await res.json();
  if (!rootHash) throw new Error("log is empty; nothing to sign");
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const prev = latestSnapshot();
  const gate = checkMonotonic(prev, { seqno, timestamp });
  if (!gate.ok) throw new Error(`monotonicity sanity-gate FAILED: ${gate.reason} — refusing to sign`);

  const path = snapshotPath(timestamp);
  const seed = loadSeed(keyPath);
  const sig = await ed.signAsync(new TextEncoder().encode(signedPayload({ seqno, rootHash, timestamp })), seed);
  const signatureB64 = Buffer.from(sig).toString("base64");

  // Co-sign if today's snapshot already exists (the other founder signed first).
  let record;
  if (existsSync(path)) {
    record = JSON.parse(readFileSync(path, "utf8"));
    if (record.seqno !== seqno || record.rootHash !== rootHash) {
      throw new Error("existing snapshot for today disagrees on seqno/rootHash — investigate before co-signing");
    }
    if (!record.signatures.some((s) => s.owner === owner)) record.signatures.push({ owner, signature: signatureB64 });
  } else {
    record = buildSnapshotRecord({ seqno, rootHash, timestamp, owner, signatureB64 });
  }
  writeJson(path, record);

  // Stamp the signed snapshot (idempotent: re-stamp on co-sign is fine, newest wins).
  const ots = await stampBytes(readFileSync(path));
  writeFileSync(`${path}.ots`, ots);
  console.log(`signed + stamped ${path} as ${owner} (seqno=${seqno})`);
  console.log("Next: git add snapshots/ && git commit && git push (or open a PR).");
}

function writeJson(p, v) { writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); }

main().catch((err) => { console.error(err?.message ?? String(err)); process.exit(1); });
