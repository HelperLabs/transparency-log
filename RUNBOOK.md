# Founder weekly-signing runbook

Once a week, each founder signs the current transparency-log root.

1. Pull latest: `git pull --ff-only`
2. Install deps once: `npm ci`
3. Sign + stamp (key never leaves your machine):
   ```bash
   node scripts/sign-snapshot.mjs --owner <aaron|peter> --key ~/.mypenny/keys/<you>.ed25519.pem
   ```
   - It fetches the live root, checks its shape (integer `seqno`, 64-char
     lowercase hex `rootHash`), runs the monotonicity sanity-gate, signs
     `mypenny-tlog-snapshot-v1\n<seqno>\n<rootHash>\n<timestamp>`, writes
     `snapshots/<today>.json`, and stamps it (`.ots`). A fresh proof is
     pending: it only becomes a Bitcoin attestation after the anchor job
     upgrades it (see "Anchor job" below).
   - If the other founder already created today's snapshot, it co-signs the
     same file. The co-signer signs the `seqno`, `rootHash` and `timestamp`
     already in the file, even if the live log has grown since. It refuses if
     the live log is behind the file, or has the same `seqno` with a different
     `rootHash`.
4. Commit + push (or open a PR):
   ```bash
   git add snapshots/ && git commit -m "snapshot: $(date -u +%Y-%m-%d)" && git push
   ```
   > If branch protection is enabled on the default branch, founders push a
   > branch and open a PR instead of pushing directly. The anchor bot
   > (`anchor.yml`) likewise needs an allowance to push to the default branch —
   > add GitHub Actions under Settings → Branches → "Allow specified actors to
   > bypass required pull requests", or point the workflow at a dedicated app
   > token with bypass rights.
5. CI (`verify-snapshot.yml`) checks both signatures against `keys.json`, then
   runs `scripts/verify-ots.mjs`, which verifies every complete proof against its
   source file. A proof that is still pending is skipped until its source record
   is 7 days old, then it fails the check.

**What this does and doesn't guarantee:** the monotonicity gate is a sanity
check, not a cryptographic non-rewrite proof. The real immutability comes from
the OpenTimestamps Bitcoin anchor: once a root is stamped, it cannot be
retroactively changed without the mismatch being publicly detectable.

## Verifying a proof yourself

Anyone can check a `.ots` proof without trusting this repo's scripts. The npm
package `opentimestamps` installs a command-line tool named `ots-cli.js`:

```bash
npx ots-cli.js verify snapshots/<date>.json.ots
```

Run it from a checkout after `npm ci`. It looks for the source file next to the
proof (the same name without `.ots`), and it needs network access to a Bitcoin
block explorer. `npx ots-cli.js info <file>.ots` prints a proof's structure
offline. To check every proof in the repo at once, run
`node scripts/verify-ots.mjs`.

## Anchor job (`anchor.yml`)

The anchor job reads the live root, stamps it when it changed (or once a day as a
heartbeat), and upgrades pending proofs, both the hourly anchors under
`anchors/` and every signed snapshot under `snapshots/`. It commits the new
anchors and the upgraded `.ots` files. It never touches a signed `.json`.

**The hourly schedule is off.** The `schedule:` trigger in `anchor.yml` is
commented out. Until it is enabled, run the job by hand from the Actions tab
(workflow `Anchor log root`, "Run workflow"):

- **Dry run** (the default): reads the live root and prints what would be
  anchored, which proofs would be upgraded, and which files would be written. It
  stamps nothing, contacts no OpenTimestamps calendar, and commits nothing.
  Locally, the same thing is `node scripts/anchor.mjs --dry-run`.
- **Real run**: untick `dry_run`. This publishes to the public calendars and
  pushes a commit.

To turn the schedule on:

1. Dispatch a dry run and read the log.
2. Dispatch one real run and review the commit it pushes: a record under
   `anchors/`, its `.ots`, `anchors/latest.json` and `anchors/pending.json`.
3. Wait for the Bitcoin confirmation (hours, not minutes), dispatch another real
   run, and check that the proof was upgraded (`npx ots-cli.js info anchors/<year>/<month>/<file>.json.ots` shows a
   Bitcoin block attestation) and that `node scripts/verify-ots.mjs` passes.
4. Uncomment the `schedule:` block in `anchor.yml` in a one-line PR.

While the schedule is off, nothing upgrades the founders' snapshot proofs
automatically. If one reaches 7 days pending, CI fails it. Either dispatch a
real anchor run, or upgrade just that proof by hand:

```bash
npx ots-cli.js upgrade snapshots/<date>.json.ots
```

Commits that the anchor job pushes with the built-in `GITHUB_TOKEN` do not start
other workflows, so `verify-snapshot.yml` does not run on them. The next push or
pull request that touches `anchors/` or `snapshots/` verifies them.
