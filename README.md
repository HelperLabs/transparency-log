# MyPenny transparency log

Public accountability artifacts for [MyPenny](https://mypenny.ai)'s
encrypted-memory architecture: every use of the keys that protect user
content is published to a public, Merkle-tree-backed log, and this repo
holds the pieces that make that log independently verifiable.

| What | Where |
|---|---|
| Live log API | https://mypenny-transparency-log.mypenny.workers.dev (`/api/log/root` for the current signed tree head) |
| Log viewer | https://mypenny-transparency-viewer.pages.dev (placeholder, viewer in progress) |
| Key-use policy | [`policy.md`](policy.md) |
| Founder signing keys | [`keys.json`](keys.json) |
| Weekly signed snapshots | [`snapshots/`](snapshots/) |

## Why this repo exists

The log itself runs on Cloudflare (deliberately a different cloud than the
AWS KMS that holds the encryption keys — a single-cloud compromise must
not be able to both read data and hide that it did). This repo is the
third leg: weekly root-hash snapshots, signed by both HelperLabs founders'
Ed25519 keys, are committed here. A Cloudflare account compromise cannot
retroactively rewrite log history without breaking the chain of snapshots
recorded in this repo's git history (and anchored to
[Sigstore Rekor](https://docs.sigstore.dev/logging/overview/)).

## Verifying

- `keys.json` holds the founders' Ed25519 public keys (raw 32-byte hex —
  the format MyPenny's `verifyDualSignoff` consumes — plus PEM for
  standard tooling).
- Every PR or push touching `snapshots/` or `keys.json` runs CI that
  verifies snapshot signatures against `keys.json`
  ([workflow](.github/workflows/verify-snapshot.yml)).
- Snapshot format is documented in [`snapshots/README.md`](snapshots/README.md).

## Status

- 2026-06-10: log worker live in production; audit-event publishing
  enabled; Aaron's signing key registered. Peter's key and the first
  witness snapshots land with the witness-signing CLI.
