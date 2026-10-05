// test/workflows.test.mjs
// Guards for the go-live review items that live in workflow YAML, which has no
// other test. Line-based on purpose: no YAML parser dependency. Comments are
// stripped first, so a commented-out `schedule:` does not count as enabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
  const text = readFileSync(join(DIR, f), "utf8");
  const live = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // drop whole-line comments
  return { name: f, text, live };
});
const named = (n) => workflows.find((w) => w.name === n);

test("there is a workflow that runs npm test on pull_request and on push", () => {
  const w = workflows.find((x) => /^\s*-?\s*run:\s*npm test\s*$/m.test(x.live));
  assert.ok(w, "no workflow runs `npm test`");
  assert.match(w.live, /^\s{2}pull_request:/m);
  assert.match(w.live, /^\s{2}push:/m);
});

test("anchor.yml: the hourly schedule is commented out", () => {
  const anchor = named("anchor.yml");
  assert.doesNotMatch(anchor.live, /^\s*schedule:/m);
  assert.doesNotMatch(anchor.live, /cron:/);
  assert.match(anchor.text, /#\s*schedule:/, "the commented-out schedule should stay as a ready-to-enable block");
});

test("anchor.yml: workflow_dispatch takes a dry_run input that defaults to true", () => {
  const live = named("anchor.yml").live;
  assert.match(live, /workflow_dispatch:/);
  assert.match(live, /dry_run:\s*\n(\s+.*\n)*?\s+type: boolean\n\s+default: true/);
  assert.match(live, /--dry-run/);
});
