// scripts/anchor.mjs
// Usage: node scripts/anchor.mjs [--dry-run]
//   --dry-run  read the live root and print what would be anchored. Stamps
//              nothing, contacts no OTS calendar, writes no file.
import { argv } from "node:process";
import { runAnchor } from "./lib/anchorRun.mjs";
import { stampBytes, upgradeOts, isComplete } from "./lib/ots.mjs";

// A real run publishes to public calendars, so an unrecognized flag (a typo of
// --dry-run, say) must stop the run, not silently fall through to one.
const args = argv.slice(2);
if (args.some((a) => a !== "--dry-run")) {
  console.error("usage: node scripts/anchor.mjs [--dry-run]");
  process.exit(2);
}

const ROOT_URL = process.env.ROOT_URL
  ?? "https://mypenny-transparency-log.mypenny.workers.dev/api/log/root";

runAnchor({
  rootUrl: ROOT_URL,
  upgrade: upgradeOts,
  stamp: stampBytes,
  isComplete,
  dryRun: args.includes("--dry-run"),
}).catch((err) => { console.error(`anchor failed: ${err?.message ?? err}`); process.exit(1); });
