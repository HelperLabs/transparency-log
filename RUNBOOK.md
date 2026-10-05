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

**It runs every hour, on the hour** (the `schedule:` trigger in `anchor.yml`).
GitHub may delay or skip a scheduled run; the next one catches up. It can also
be run by hand from the Actions tab (workflow `Anchor log root`, "Run
workflow"):

- **Dry run** (the default): reads the live root and prints what would be
  anchored, which proofs would be upgraded, and which files would be written. It
  stamps nothing, contacts no OpenTimestamps calendar, and commits nothing.
  Locally, the same thing is `node scripts/anchor.mjs --dry-run`.
- **Real run**: untick `dry_run`. This publishes to the public calendars and
  pushes a commit.

The schedule went on 2026-10-05, after this sequence: a dry run; one real run
whose commit was reviewed (the anchor at 03:08 UTC, log size 7,393,736); a wait
for its Bitcoin confirmation (block 969,949); a second real run that upgraded
that proof; and `node scripts/verify-ots.mjs` passing on it.

If anchors stop appearing, check the Actions tab. GitHub disables a scheduled
workflow after 60 days without repository activity, and shows a button to
turn it back on.

Each run also upgrades the founders' snapshot proofs. If runs stop and one
reaches 7 days pending, CI fails it. Either dispatch a real anchor run, or
upgrade just that proof by hand:

```bash
npx ots-cli.js upgrade snapshots/<date>.json.ots
```

Commits that the anchor job pushes with the built-in `GITHUB_TOKEN` do not start
other workflows, so `verify-snapshot.yml` does not run on them. The next push or
pull request that touches `anchors/` or `snapshots/` verifies them.
