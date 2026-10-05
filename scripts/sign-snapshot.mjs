// scripts/sign-snapshot.mjs
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import * as ed from "@noble/ed25519";
import { signSnapshot } from "./lib/signSnapshot.mjs";
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

async function main() {
  const owner = arg("owner");
  const keyPath = arg("key");
  if (!owner || !keyPath) throw new Error("usage: sign-snapshot.mjs --owner <name> --key <path>");

  const res = await fetch(ROOT_URL);
  if (!res.ok) throw new Error(`root fetch ${res.status}`);
  const live = await res.json();

  const seed = loadSeed(keyPath);
  const sign = async (payload) =>
    Buffer.from(await ed.signAsync(new TextEncoder().encode(payload), seed)).toString("base64");

  const { path, record } = await signSnapshot({ live, now: Date.now(), owner, sign, stamp: stampBytes });
  console.log(`signed + stamped ${path} as ${owner} (seqno=${record.seqno})`);
  console.log("Next: git add snapshots/ && git commit && git push (or open a PR).");
}

main().catch((err) => { console.error(err?.message ?? String(err)); process.exit(1); });
