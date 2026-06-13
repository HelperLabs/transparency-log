# Founder weekly-signing runbook

Once a week, each founder signs the current transparency-log root.

1. Pull latest: `git pull --ff-only`
2. Install deps once: `npm ci`
3. Sign + stamp (key never leaves your machine):
   ```bash
   node scripts/sign-snapshot.mjs --owner <aaron|peter> --key ~/.mypenny/keys/<you>.ed25519.pem
   ```
   - It fetches the live root, runs the monotonicity sanity-gate, signs
     `<seqno>\n<rootHash>\n<timestamp>`, writes `snapshots/<today>.json`, and
     stamps it (`.ots`).
   - If the other founder already created today's snapshot, it co-signs the
     same file.
4. Commit + push (or open a PR):
   ```bash
   git add snapshots/ && git commit -m "snapshot: $(date -u +%Y-%m-%d)" && git push
   ```
   > If branch protection is enabled on the default branch, founders push a
   > branch and open a PR instead of pushing directly. The hourly anchor bot
   > (`anchor.yml`) likewise needs an allowance to push to the default branch —
   > add GitHub Actions under Settings → Branches → "Allow specified actors to
   > bypass required pull requests", or point the workflow at a dedicated app
   > token with bypass rights.
5. CI (`verify-snapshot.yml`) checks both signatures against `keys.json` and
   `ots verify`s any complete proofs.

**What this does and doesn't guarantee:** the monotonicity gate is a sanity
check, not a cryptographic non-rewrite proof. The real immutability comes from
the OpenTimestamps Bitcoin anchor: once a root is stamped, it cannot be
retroactively changed without the mismatch being publicly detectable.
