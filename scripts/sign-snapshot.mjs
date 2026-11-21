// scripts/sign-snapshot.mjs
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import * as ed from "@noble/ed25519";
import { DEFAULT_LOG_BASE } from "./lib/anchorRun.mjs";
import { LEGACY_SHARD, parseShards, parseCheckpoint } from "./lib/anchorDecision.mjs";
import { latestSnapshot, signSnapshot } from "./lib/signSnapshot.mjs";
import { stampBytes } from "./lib/ots.mjs";

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

async function fetchLiveForSigning(dir) {
  const logBase = process.env.LOG_BASE
    ? process.env.LOG_BASE
    : process.env.ROOT_URL
      ? undefined
      : DEFAULT_LOG_BASE;

  if (!logBase) {
    const res = await fetch(process.env.ROOT_URL);
    if (!res.ok) throw new Error(`root fetch ${res.status}`);
    return { live: await res.json(), shardLink: undefined };
  }

  const base = logBase.replace(/\/+$/, "");
  const shardsRes = await fetch(`${base}/api/log/shards`);
  if (shardsRes.status === 404) {
    const res = await fetch(`${base}/api/log/root`);
    if (!res.ok) throw new Error(`root fetch ${res.status}`);
    return { live: await res.json(), shardLink: undefined };
  }
  if (!shardsRes.ok) throw new Error(`shards fetch ${shardsRes.status}`);
  const shards = parseShards(await shardsRes.text());
  const openShards = shards.filter((s) => s.state === "open");
  if (openShards.length !== 1) throw new Error(`expected 1 open shard, got ${openShards.length}`);
  const openShard = openShards[0].shard;

  const cpRes = await fetch(`${base}/api/log/${openShard}/checkpoint`);
  if (!cpRes.ok) throw new Error(`checkpoint fetch for ${openShard} returned ${cpRes.status}`);
  const cp = parseCheckpoint(await cpRes.text(), openShard);
  if (cp.sealed) throw new Error(`open shard ${openShard} checkpoint reported sealed=true`);

  let shardLink;
  const prev = latestSnapshot(dir);
  if (prev && (prev.shard ?? LEGACY_SHARD) !== openShard) {
    const linkRes = await fetch(`${base}/api/log/${openShard}/event/1`);
    if (!linkRes.ok) throw new Error(`ShardLink fetch /api/log/${openShard}/event/1 returned ${linkRes.status}`);
    shardLink = await linkRes.json();
  }
  return { live: { shard: cp.shard, size: cp.size, rootHash: cp.size === 0 ? "" : cp.rootHash }, shardLink };
}

async function main() {
  const owner = arg("owner");
  const keyPath = arg("key");
  if (!owner || !keyPath) throw new Error("usage: sign-snapshot.mjs --owner <name> --key <path>");

  const { live, shardLink } = await fetchLiveForSigning("snapshots");

  const seed = loadSeed(keyPath);
  const sign = async (payload) =>
    Buffer.from(await ed.signAsync(new TextEncoder().encode(payload), seed)).toString("base64");

  const { path, record } = await signSnapshot({ live, shardLink, now: Date.now(), owner, sign, stamp: stampBytes });
  const label = record.shard ? `${record.shard}/${record.seqno}` : String(record.seqno);
  console.log(`signed + stamped ${path} as ${owner} (${label})`);
  console.log("Next: git add snapshots/ && git commit && git push (or open a PR).");
}

main().catch((err) => { console.error(err?.message ?? String(err)); process.exit(1); });
