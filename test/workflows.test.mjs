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

test("every workflow declares least-privilege permissions at the top level", () => {
  for (const w of workflows) assert.match(w.live, /^permissions:\s*\n\s+contents: (read|write)/m, w.name);
  assert.match(named("verify-snapshot.yml").live, /^permissions:\s*\n\s+contents: read/m);
  assert.match(named("test.yml").live, /^permissions:\s*\n\s+contents: read/m);
});

test("every job has a timeout", () => {
  for (const w of workflows) {
    const jobs = (w.live.match(/^ {4}runs-on:/gm) ?? []).length;
    const timeouts = (w.live.match(/^ {4}timeout-minutes: \d+/gm) ?? []).length;
    assert.ok(jobs > 0, w.name);
    assert.equal(timeouts, jobs, `${w.name}: ${jobs} job(s), ${timeouts} timeout(s)`);
  }
});

test("third-party actions are pinned to a full commit SHA with the version in a comment", () => {
  for (const w of workflows) {
    const uses = w.text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    assert.ok(uses.length > 0, w.name);
    for (const l of uses) assert.match(l, /uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/, `${w.name}: ${l.trim()}`);
  }
});

test("installs skip dependency lifecycle scripts", () => {
  for (const w of workflows) {
    for (const l of w.live.split("\n").filter((x) => /npm (ci|install)/.test(x))) {
      assert.match(l, /--ignore-scripts/, `${w.name}: ${l.trim()}`);
    }
  }
});

test("checkouts that do not push drop the persisted token", () => {
  for (const w of workflows.filter((x) => x.name !== "anchor.yml")) {
    const checkouts = (w.live.match(/uses: actions\/checkout@/g) ?? []).length;
    const dropped = (w.live.match(/persist-credentials: false/g) ?? []).length;
    assert.equal(dropped, checkouts, w.name);
  }
});

test("anchor.yml: git add never gets a pathspec that can match nothing", () => {
  // `git add` exits 128 when a pathspec matches no files. snapshots/ holds no
  // .ots until a founder signs, so a glob pathspec there failed the first real
  // run (2026-10-05) after the stamp had already been submitted.
  const anchor = named("anchor.yml");
  const adds = anchor.live.split("\n").filter((l) => /\bgit add\b/.test(l));
  assert.ok(adds.length > 0, "anchor.yml should stage its changes");
  for (const l of adds) {
    const args = l.slice(l.indexOf("git add"));
    assert.doesNotMatch(args, /:\(glob\)|\*/, `glob pathspec passed to git add: ${l.trim()}`);
  }
});
