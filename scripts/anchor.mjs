// scripts/anchor.mjs
// Usage: node scripts/anchor.mjs [--dry-run] [--out <dir>]
//   --dry-run    read the live log and print what would be anchored. Stamps
//                nothing, contacts no OTS calendar, writes no file.
//   --out <dir>  write anchors, latest.json and pending.json under <dir>
//                instead of anchors/ (used for off-repo rehearsal runs).
import { argv } from "node:process";
import { DEFAULT_LOG_BASE, runAnchor } from "./lib/anchorRun.mjs";
import { stampBytes, upgradeOts, isComplete } from "./lib/ots.mjs";

const USAGE = "usage: node scripts/anchor.mjs [--dry-run] [--out <dir>]";

// A real run publishes to public calendars, so an unrecognized flag (a typo of
// --dry-run, say) must stop the run, not silently fall through to one.
const args = argv.slice(2);
let dryRun = false;
let outDir;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") {
    dryRun = true;
  } else if (a === "--out") {
    const next = args[++i];
    if (!next || next.startsWith("-")) {
      console.error(USAGE);
      process.exit(2);
    }
    outDir = next;
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}

const logBase = process.env.LOG_BASE
  ? process.env.LOG_BASE
  : process.env.ROOT_URL
    ? undefined
    : DEFAULT_LOG_BASE;
const rootUrl = logBase ? undefined : process.env.ROOT_URL;

runAnchor({
  logBase,
  rootUrl,
  outDir,
  upgrade: upgradeOts,
  stamp: stampBytes,
  isComplete,
  dryRun,
}).catch((err) => { console.error(`anchor failed: ${err?.message ?? err}`); process.exit(1); });
