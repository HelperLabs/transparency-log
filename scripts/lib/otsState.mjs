// scripts/lib/otsState.mjs
export function addPending(pending, path) {
  return pending.includes(path) ? pending : [...pending, path];
}
export function removeCompleted(pending, completedSet) {
  return pending.filter((p) => !completedSet.has(p));
}

/**
 * How long a proof may stay pending (no Bitcoin attestation yet) before
 * verification fails instead of skipping it. Calendars normally confirm within
 * hours and the hourly anchor job upgrades proofs as they land, so a week with
 * no attestation means upgrades are not running or the proof is broken.
 */
export const MAX_PENDING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When a proof's source record was created, in ms since the epoch, or null.
 * Anchor records carry `capturedAt`; signed snapshots carry `timestamp`. The
 * proof is stamped at or after that moment, so this is an upper bound on its age.
 */
export function recordTime(record) {
  const t = Date.parse(record?.capturedAt ?? record?.timestamp ?? "");
  return Number.isNaN(t) ? null : t;
}

/** Decide whether a still-pending proof is young enough to skip. */
export function pendingVerdict({ record, now, maxPendingMs = MAX_PENDING_MS }) {
  const t = recordTime(record);
  if (t === null) {
    return { ok: false, reason: "source record has no readable capturedAt/timestamp; cannot bound pending age" };
  }
  const ageMs = now - t;
  if (ageMs > maxPendingMs) {
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const limit = Math.round(maxPendingMs / (24 * 60 * 60 * 1000));
    return { ok: false, ageMs, reason: `still pending after ${days} days (limit ${limit}); has the anchor job stopped upgrading proofs?` };
  }
  return { ok: true, ageMs };
}
