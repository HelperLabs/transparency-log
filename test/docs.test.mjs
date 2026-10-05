// test/docs.test.mjs
// The docs once told people to run an `ots` command that the npm package does
// not install. Keep them pointing at the real bin and at this repo's verifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bins = Object.keys(require("opentimestamps/package.json").bin);
const docs = { "RUNBOOK.md": readFileSync("RUNBOOK.md", "utf8"), "snapshots/README.md": readFileSync("snapshots/README.md", "utf8") };

test("docs name the CLI the opentimestamps package really installs", () => {
  assert.deepEqual(bins, ["ots-cli.js"]);
  for (const [name, text] of Object.entries(docs)) assert.match(text, /ots-cli\.js verify/, name);
});

test("docs no longer tell people to run a bare `ots` command or install the old package", () => {
  for (const [name, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /\bots verify\b/, name);
    assert.doesNotMatch(text, /javascript-opentimestamps/, name);
  }
});

test("docs mention this repo's own verifier, the dry run and the commented-out schedule", () => {
  assert.match(docs["snapshots/README.md"], /node scripts\/verify-ots\.mjs/);
  assert.match(docs["RUNBOOK.md"], /node scripts\/verify-ots\.mjs/);
  assert.match(docs["RUNBOOK.md"], /node scripts\/anchor\.mjs --dry-run/);
  assert.match(docs["RUNBOOK.md"], /schedule is off/i);
});
