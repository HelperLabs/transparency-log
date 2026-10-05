# Penny key-use policy

This document defines what counts as **standard usage** of the encryption keys
that protect Penny user content, and what we publish about every key use.
It is the policy referenced by the [Penny transparency
log](https://mypenny-transparency-log.mypenny.workers.dev) and by the
encryption language at [mypenny.ai/privacy](https://mypenny.ai/privacy).

**The core commitment:** memory content is encrypted with keys Helper Labs
holds and never uses outside this published policy. Every time Penny's service
decrypts a user's content, the decryption is recorded before the key is used;
if the record cannot be written, the decryption does not happen. Each user can
see the list of those decryptions, with the reason for each, in their
dashboard (Settings → Privacy).

Two kinds of key use sit outside that dashboard list. Unwrapping a user's key
is recorded in AWS CloudTrail, not the dashboard. Restoring an offline backup
archive happens outside the running service and leaves no dashboard entry.

The public log carries the dashboard record in two forms:

- **Out-of-the-ordinary access** (the reason codes in the second table below)
  is published individually, one entry per event, about a minute after it
  happens.
- **Routine access** (the first table) is sealed into the log once a day: for
  each user, the day's routine records are hashed into one fingerprint (a
  Merkle root over the records, in order) and published with a pseudonymous
  id, the day, and the count.

## Standard usage (routine service operation)

These reason codes cover the routine operation of the product. They appear
in each user's dashboard decrypt history and are covered by that user's
daily commitment on the public log. They do not trigger notifications.

| Reason code | What it means |
|---|---|
| `embedding_generation` | Decrypting content to compute search embeddings |
| `sleeptime_extraction` | Background memory extraction from ingested sources |
| `tag_sleeptime` | Background tag-graph maintenance |
| `link_sleeptime` | Background linking of related notes |
| `consolidation_sweep` | Background memory consolidation / dedup |
| `compiled_artifacts_build` | Building compiled summaries and artifacts |
| `screen_summary` | Summarizing screen-capture ingestion (raw OCR is never embedded and is deleted after extraction) |
| `daily_digest` | Reading the user's tasks and memories to build their daily digest |
| `email_processing` | Classifying and drafting replies to email the user sends to Penny, including automated support triage |
| `email_delivery` | Sending the user a message they asked Penny to deliver |
| `beacon_format_backfill` | Rebuilding the private search index after a format change |
| `tag_salt_unwrap` | Unwrapping the per-user key behind private tag and search indexes |
| `user_mcp_read` | The user (or their AI tool) reading their own memories over MCP |
| `user_dashboard_read` | The user reading their own memories in the dashboard |
| `user_data_export` | The user exporting their own data |
| `user_data_deletion` | Deleting user data (decrypt-verify before destruction) |

## Out-of-the-ordinary usage (never routine)

These reason codes are exceptional. Each is published to the public log as
its own entry and appears highlighted in the affected user's dashboard.

| Reason code | What it means |
|---|---|
| `support_troubleshoot` | A support engineer reading a user's support content to diagnose a problem they reported |
| `incident_forensic` | Security-incident investigation |
| `legal_compulsion` | Compelled access under legal process (see below) |
| `compliance_audit` | Auditor-supervised compliance verification |
| `key_rotation_rewrap` | Re-encrypting content under rotated keys (bulk, content is not read) |
| `backup_archive_decrypt` | An operator opening an encrypted backup to prove a restore is readable |
| `eval_corpus_harvest` | An operator job reading a user's stored sample questions to build search-quality tests |

No email goes to the affected user when one of these happens; the dashboard
entry and the public log entry are the record. No decryption requires both
founders' signatures today (see "Dual signoff" below).

## What the log publishes (and what it never contains)

Every entry carries an event id, a type, its position in the log, and the time
the log accepted it.

An **out-of-the-ordinary entry** also contains: the reason code, the time of
the access, whether it was standard usage, a pseudonymous user id, and for
each field read the field name and pseudonymous table and row ids, plus the
acting service identity and a correlation id.

A **daily commitment** also contains: a pseudonymous user id, the day, the
count of routine records, a sequence number (a very busy day, or records that
arrive after the day closed, can produce more than one), and the fingerprint.
It carries no per-access times, reason codes, or row ids.

The pseudonymous ids are HMACs under a secret Helper Labs holds, so a reader
of the log cannot link an id to a person. A user's id is the same in every
entry.

The log **never** contains: plaintext user ids, row ids, IP addresses,
request paths, or any memory content.

## Who checks the log

The log is an append-only Merkle tree hosted on Cloudflare, on a different
cloud from user data. Helper Labs operates the integrity checks, including a
job that samples recent entries every ten minutes and recomputes daily
fingerprints from the source records.

Separately, a job in this repository timestamps the log's root through
OpenTimestamps, which commits it to the Bitcoin blockchain, and keeps each
record and proof under [`anchors/`](anchors/). A proof shows what the root was
at that time. Nobody outside Helper Labs monitors the log.

## Legal compulsion and gag orders

Our architecture cannot defend against legal compulsion to decrypt user
data, including gag-ordered orders. We commit to publishing all government
data requests in the transparency log to the maximum extent permitted by
law. If you require cryptographic defense against US legal process, this
product is not for you today.

## Dual signoff

No decryption requires both founders' signatures today. Dual signoff is a
*governance* and
separation-of-duties mechanism, not cryptographic protection against Helper
Labs the company: if both founders agreed to access user data, the system
would record their agreement publicly but would not prevent it.

## Changes to this policy

Policy changes land as commits to this public repository, so the history
of what we promised, and when, is itself auditable.

- **2026-10-05.** Rewritten to describe only what runs today. Routine access
  has been published as a daily commitment per user since 2026-09-17;
  out-of-the-ordinary access is still published per event. The previous text
  said every decryption was logged individually before the key-management
  service performed it, that out-of-the-ordinary access required dual signoff,
  and that it triggered an immediate email to the user; none of that runs
  today. Added the reason codes introduced since June. Corrected the entry
  fields: the log carries the exact time of an out-of-the-ordinary access, not
  a 5-minute bucket, and no key-version field. Added the OpenTimestamps
  anchoring of the log root, which started the same day.
