# Penny transparency log

Public accountability records for [Penny](https://mypenny.ai)'s encrypted
memory. Every time Penny's service decrypts a user's content, it records the
decryption before the key is used, and that record is sealed into a public,
append-only log: out-of-the-ordinary access as one entry per event, routine
access as one daily commitment per user. [`policy.md`](policy.md) says what
counts as each, what an entry contains, and what the log never contains.

| What | Where |
|---|---|
| Live log API | https://mypenny-transparency-log.mypenny.workers.dev (`/api/log/root` returns the current Merkle root and size) |
| Log viewer | https://mypenny-transparency-viewer.pages.dev (a placeholder today) |
| Key-use policy | [`policy.md`](policy.md) |
| Bitcoin timestamps of the log root | [`anchors/`](anchors/) |
| Founder signing keys | [`keys.json`](keys.json) |
| Founder-signed snapshots | [`snapshots/`](snapshots/) (none signed yet) |

## Why this repo exists

The log runs on Cloudflare, a different cloud from the AWS account that holds
the encryption keys, and Helper Labs operates its integrity checks. This repo
adds a record that does not depend on either:

- **Timestamps.** Every hour, a GitHub Actions job here reads the log's current root,
  timestamps it through [OpenTimestamps](https://opentimestamps.org), which
  commits it to the Bitcoin blockchain, and commits the record and its proof
  under `anchors/`. A proof shows what the log's root was at that time; nobody,
  including Helper Labs, can change it afterwards. The first anchor was recorded
  on 2026-10-05.
- **Founder-signed snapshots.** The tooling for both founders to sign the log's
  root with the Ed25519 keys in `keys.json` lives here (`scripts/sign-snapshot.mjs`).
  No snapshot has been signed yet.

## Verifying

- `node scripts/verify-ots.mjs` checks every completed OpenTimestamps proof in
  this repo against the Bitcoin blockchain. A single proof can also be checked
  with `npx ots-cli.js verify <file>.ots`.
- `keys.json` holds the founders' Ed25519 public keys (raw 32-byte hex, plus
  PEM for standard tooling). CI verifies any snapshot signature against them
  ([workflow](.github/workflows/verify-snapshot.yml)).
- Snapshot format: [`snapshots/README.md`](snapshots/README.md). How the
  anchor job runs: [`RUNBOOK.md`](RUNBOOK.md).
