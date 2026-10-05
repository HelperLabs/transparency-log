# Witness snapshots

Weekly signed snapshots of the transparency log's Merkle root. Each file is
named `YYYY-MM-DD.json` (the date of the snapshot) and has this shape:

```json
{
  "seqno": 12345,
  "rootHash": "<64-char hex sha-256 Merkle root>",
  "timestamp": "2026-06-14T00:00:00Z",
  "signatures": [
    { "owner": "aaron", "signature": "<base64 Ed25519 signature>" },
    { "owner": "peter", "signature": "<base64 Ed25519 signature>" }
  ]
}
```

The signed payload is the UTF-8 string below. The first line is a fixed
domain-separation tag, so a snapshot signature cannot double as a signature over
anything else the same key signs:

```
mypenny-tlog-snapshot-v1\n<seqno>\n<rootHash>\n<timestamp>
```

`seqno` is a non-negative integer and `rootHash` is 64 lowercase hex characters,
so none of the fields can contain a newline. The payload is signed with the
Ed25519 keys published in [`../keys.json`](../keys.json).

A co-signer signs the statement already in the file (same `seqno`, `rootHash` and
`timestamp`), not the live root, so a snapshot can carry both founders'
signatures even though the log keeps growing between their signing times.

CI verifies every snapshot on each push/PR.

Snapshots, and the machine anchors under [`../anchors/`](../anchors/), are also
anchored to the **Bitcoin blockchain via OpenTimestamps**. The `.ots` proof
beside each file is what makes it un-rewritable. A new proof starts out pending
and gains its Bitcoin attestation once the calendars' Bitcoin transaction
confirms and the anchor workflow upgrades the proof. CI fails a proof that is
still pending 7 days after its snapshot timestamp.

Anyone can verify a proof independently. The npm package `opentimestamps`
installs a command-line tool named `ots-cli.js`:

```
npm i -g opentimestamps
ots-cli.js verify <file>.ots     # looks for <file> next to the proof
```

From a checkout of this repo, `npx ots-cli.js verify <file>.ots` works after
`npm ci`, and `node scripts/verify-ots.mjs` checks every proof at once.
