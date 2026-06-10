# MyPenny key-use policy

This document defines what counts as **standard usage** of the encryption keys
that protect MyPenny user content, and what we publish about every key use.
It is the policy referenced by the [MyPenny transparency
log](https://mypenny-transparency-log.mypenny.workers.dev) and by the
encryption language at [mypenny.ai/privacy](https://mypenny.ai/privacy).

**The core commitment:** memory content is encrypted with keys HelperLabs
holds and never uses outside this published policy. Every decryption is
logged to the public transparency log *before* the key-management service
will perform it, and every user can see every decryption affecting their
data in their dashboard.

## Standard usage (routine service operation)

These reason codes cover the routine operation of the product. They appear
in each user's dashboard decrypt history but do not trigger notification
emails.

| Reason code | What it means |
|---|---|
| `embedding_generation` | Decrypting content to compute search embeddings |
| `sleeptime_extraction` | Background memory extraction from ingested sources |
| `tag_sleeptime` | Background tag-graph maintenance |
| `consolidation_sweep` | Background memory consolidation / dedup |
| `compiled_artifacts_build` | Building compiled summaries and artifacts |
| `screen_summary` | Summarizing screen-capture ingestion (raw OCR is never embedded and is deleted after extraction) |
| `user_mcp_read` | The user (or their AI tool) reading their own memories over MCP |
| `user_dashboard_read` | The user reading their own memories in the dashboard |
| `user_data_export` | The user exporting their own data |
| `user_data_deletion` | Deleting user data (decrypt-verify before destruction) |

## Anomalous usage (never routine — always notified)

These reason codes are exceptional. Each requires **cryptographic dual
signoff** by both HelperLabs founders (verified against the keys in
[`keys.json`](keys.json)), is published to the transparency log, appears
highlighted in the affected user's dashboard, and triggers an immediate
email to the affected user except where prohibited by law.

| Reason code | What it means |
|---|---|
| `support_troubleshoot` | Support access to diagnose a user-reported problem, with the user's consent |
| `incident_forensic` | Security-incident investigation |
| `legal_compulsion` | Compelled access under legal process (see below) |
| `compliance_audit` | Auditor-supervised compliance verification |
| `key_rotation_rewrap` | Re-encrypting content under rotated keys (bulk, content is not read) |

## What the log publishes (and what it never contains)

Each log event contains: a 5-minute-bucketed timestamp, the reason code,
whether it was standard usage, an HMAC of the user id (so users can
self-audit via their dashboard without being publicly identifiable), HMACs
of the table/row touched, the field name, the acting service identity, a
correlation id, and key-version/algorithm metadata.

The log **never** contains: plaintext user ids, row ids, IP addresses,
request paths, or any memory content.

## Legal compulsion and gag orders

Our architecture cannot defend against legal compulsion to decrypt user
data, including gag-ordered orders. We commit to publishing all government
data requests in the transparency log to the maximum extent permitted by
law. If you require cryptographic defense against US legal process, this
product is not for you today.

## Honest framing of dual signoff

Dual signoff between the two founders is a *governance* and
separation-of-duties mechanism. It is **not** cryptographic protection
against HelperLabs-the-company: if both founders agree to access user
data, the system records their agreement publicly but does not prevent it.
What it does guarantee is that no single person — founder, employee, or
someone holding one compromised key — can perform an anomalous decrypt
silently.

## Changes to this policy

Policy changes land as commits to this public repository, so the history
of what we promised — and when — is itself auditable.
