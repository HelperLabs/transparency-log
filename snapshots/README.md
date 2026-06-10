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

The signed payload is the UTF-8 string:

```
<seqno>\n<rootHash>\n<timestamp>
```

signed with the Ed25519 keys published in [`../keys.json`](../keys.json).
CI verifies every snapshot on each push/PR. Snapshots are also anchored to
Sigstore Rekor (see the witness-signing CLI, MyPenny issue #48).
