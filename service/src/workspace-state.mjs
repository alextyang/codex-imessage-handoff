import { readFileSync, statSync } from "node:fs";
import { servicePaths } from "./paths.mjs";

let cached = null;

function emptyState() {
  return {
    projectlessThreadIds: new Set(),
    workspaceRootHints: new Map(),
  };
}

function parseState(source) {
  const value = JSON.parse(source);
  const projectless = Array.isArray(value?.["projectless-thread-ids"])
    ? value["projectless-thread-ids"].filter((id) => typeof id === "string" && id)
    : [];
  const rawHints = value?.["thread-workspace-root-hints"];
  const hints = rawHints && typeof rawHints === "object" && !Array.isArray(rawHints)
    ? Object.entries(rawHints).filter(([id, root]) => typeof id === "string" && id && typeof root === "string" && root.trim())
    : [];
  return {
    projectlessThreadIds: new Set(projectless),
    workspaceRootHints: new Map(hints),
  };
}

export function readWorkspaceState() {
  const file = servicePaths().globalState;
  try {
    const stat = statSync(file);
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (cached?.file === file && cached.key === key) return cached.value;
    const value = parseState(readFileSync(file, "utf8"));
    cached = { file, key, value };
    return value;
  } catch {
    // Codex rewrites this file in place. Preserve the last valid snapshot if a
    // read lands between truncate and rename so tasks do not jump groups.
    return cached?.file === file ? cached.value : emptyState();
  }
}

export function resetWorkspaceStateCache() {
  cached = null;
}
