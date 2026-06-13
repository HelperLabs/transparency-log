// scripts/lib/otsState.mjs
export function addPending(pending, path) {
  return pending.includes(path) ? pending : [...pending, path];
}
export function removeCompleted(pending, completedSet) {
  return pending.filter((p) => !completedSet.has(p));
}
