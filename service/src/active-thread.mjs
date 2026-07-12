function dateMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isDescendant(candidate, ancestorId, byId) {
  if (Array.isArray(candidate?.lineageAncestorIds)
    && candidate.lineageAncestorIds.some((id) => String(id) === ancestorId)) {
    return true;
  }
  const visited = new Set();
  let parentId = String(candidate?.forkedFromId || "");
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = String(byId.get(parentId)?.forkedFromId || "");
  }
  return false;
}

export function activeDescendant(threads, activeThreadId, selectedAt) {
  const activeId = String(activeThreadId || "");
  if (!activeId) return null;
  const byId = new Map((threads || []).map((thread) => [String(thread?.id || ""), thread]));
  const active = byId.get(activeId);
  // The desktop archives a parent when it forks into a new top-level task, so
  // a remotely selected ancestor may no longer be present in the visible
  // catalog. Exact full-lineage metadata still makes that descendant safe to
  // follow. A visible running selection remains authoritative.
  if (active?.state === "running") return null;
  const selectedMs = dateMs(selectedAt) ?? Date.now();
  return [...byId.values()]
    .filter((thread) => thread?.id !== activeId
      && thread?.state === "running"
      && (dateMs(thread.activityAt) ?? dateMs(thread.updatedAt) ?? 0) > selectedMs
      && isDescendant(thread, activeId, byId))
    .sort((left, right) => (
      (dateMs(right.activityAt) ?? dateMs(right.updatedAt) ?? 0)
      - (dateMs(left.activityAt) ?? dateMs(left.updatedAt) ?? 0)
      || (dateMs(right.createdAt) ?? 0) - (dateMs(left.createdAt) ?? 0)
      || String(right.id).localeCompare(String(left.id))
    ))[0] || null;
}
