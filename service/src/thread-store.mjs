import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, openSync, closeSync, readSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { servicePaths } from "./paths.mjs";
import { getThreadState } from "./thread-history.mjs";
import { readWorkspaceState } from "./workspace-state.mjs";

const execFileAsync = promisify(execFile);
const MAX_THREADS = 500;

function iso(ms, seconds) {
  const value = Number(ms) || Number(seconds) * 1000;
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function normalizedCwd(cwd) {
  const value = String(cwd || "").trim();
  if (!value) return "Codex";
  return path.normalize(value).replace(new RegExp(`${path.sep}+$`), "") || path.parse(value).root || value;
}

export function projectLabel(cwd) {
  const normalized = normalizedCwd(cwd);
  if (normalized === "Codex") return normalized;
  return (path.basename(normalized) || "Codex").slice(0, 120);
}

export function projectKey(cwd) {
  const identity = normalizedCwd(cwd);
  return `project_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function safeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return MAX_THREADS;
  return Math.max(1, Math.min(MAX_THREADS, Math.floor(value)));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const ROOT_THREAD_PREDICATE = `
  t.archived = 0
  AND t.preview <> ''
  AND t.source <> 'exec'
  AND COALESCE(t.thread_source, '') <> 'subagent'
  AND t.source NOT LIKE '%"subagent"%'
  AND NOT EXISTS (
    SELECT 1 FROM thread_spawn_edges edge WHERE edge.child_thread_id = t.id
  )`;

const THREAD_COLUMNS = `
  t.id,
  t.rollout_path,
  t.title,
  t.cwd,
  t.archived,
  t.created_at,
  t.updated_at,
  t.created_at_ms,
  t.updated_at_ms,
  t.recency_at,
  t.recency_at_ms,
  t.preview,
  t.model,
  t.reasoning_effort,
  t.model_provider,
  t.git_origin_url,
  t.git_branch`;

async function query(sql) {
  const database = servicePaths().stateDb;
  if (!existsSync(database)) throw new Error(`Codex state database not found: ${database}`);
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", database, sql], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

function threadFromRow(row, workspaceState = readWorkspaceState()) {
  const id = String(row.id);
  const cwd = normalizedCwd(row.cwd);
  const projectless = workspaceState.projectlessThreadIds.has(id);
  const hintedRoot = workspaceState.workspaceRootHints.get(id);
  const workspaceRoot = projectless ? null : normalizedCwd(hintedRoot || cwd);
  const updatedAt = iso(row.updated_at_ms, row.updated_at);
  const recencyAt = iso(row.recency_at_ms, row.recency_at) || updatedAt;
  const observed = getThreadState(String(row.rollout_path || ""));
  const forkedFromId = forkParent(String(row.rollout_path || ""));
  const activityAt = observed.activityAt || updatedAt || recencyAt;
  return {
    id,
    title: String(row.title || "Untitled thread").replace(/\s+/g, " ").trim().slice(0, 160),
    cwd,
    workspaceRoot,
    groupKind: projectless ? "other" : "project",
    projectKey: projectless ? null : projectKey(workspaceRoot),
    projectLabel: projectless ? null : projectLabel(workspaceRoot),
    rolloutPath: String(row.rollout_path || ""),
    forkedFromId,
    createdAt: iso(row.created_at_ms, row.created_at),
    updatedAt,
    recencyAt,
    recencyAtMs: Date.parse(recencyAt || "") || null,
    activityAt,
    activityAtMs: observed.activityAtMs || Date.parse(activityAt || "") || null,
    lastTurnAt: observed.lastTurnAt || null,
    lastTurnAtMs: observed.lastTurnAtMs || null,
    stateSince: observed.stateSince || activityAt,
    state: observed.state,
    currentTurnId: observed.currentTurnId,
    historyTruncated: observed.truncated,
    malformedHistoryTail: observed.malformedTail,
    model: typeof row.model === "string" && row.model ? row.model : null,
    reasoningEffort: typeof row.reasoning_effort === "string" && row.reasoning_effort ? row.reasoning_effort : null,
    modelProvider: typeof row.model_provider === "string" && row.model_provider ? row.model_provider : null,
    gitOriginUrl: typeof row.git_origin_url === "string" && row.git_origin_url ? row.git_origin_url : null,
    gitBranch: typeof row.git_branch === "string" && row.git_branch ? row.git_branch : null,
    archived: Boolean(row.archived),
    visible: Boolean(row.preview),
  };
}

function forkParent(file) {
  if (!file) return null;
  let descriptor;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, length).toString("utf8").split("\n", 1)[0];
    const record = JSON.parse(first);
    const value = record?.type === "session_meta" ? record?.payload?.forked_from_id : null;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function dedupeRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id || "");
    if (!id || byId.has(id)) continue;
    byId.set(id, row);
  }
  return [...byId.values()];
}

function lineageMetadata(rows) {
  const parents = new Map(rows.map((row) => [String(row.id), forkParent(String(row.rollout_path || ""))]));
  const roots = new Map();
  const resolve = (id) => {
    if (roots.has(id)) return roots.get(id);
    const chain = [];
    const seen = new Set();
    let current = id;
    let cycle = false;
    while (current) {
      if (seen.has(current)) {
        cycle = true;
        break;
      }
      if (roots.has(current)) {
        current = roots.get(current);
        break;
      }
      seen.add(current);
      chain.push(current);
      const parent = parents.get(current);
      if (!parent) break;
      // Preserve a missing/filtered ancestor as the shared lineage key. Two
      // visible descendants of the same archived parent must still collapse.
      current = parent;
      if (!parents.has(current)) break;
    }
    if (cycle) current = [...seen].sort()[0];
    const root = current || id;
    for (const member of chain) roots.set(member, root);
    return root;
  };
  for (const id of parents.keys()) resolve(id);

  // Visible catalog rows are only a subset of the complete threads table.
  // Keep each row's exact ancestor chain so fork following can cross an
  // archived/filtered intermediate task without treating a sibling as a
  // descendant. Missing terminal parents are retained as useful identities.
  const ancestors = new Map();
  for (const id of parents.keys()) {
    const chain = [];
    const seen = new Set([id]);
    let parent = parents.get(id);
    while (parent && !seen.has(parent)) {
      chain.push(parent);
      seen.add(parent);
      parent = parents.get(parent);
    }
    ancestors.set(id, chain);
  }
  return { roots, ancestors };
}

function stableThreadOrder(left, right) {
  const leftCreated = Date.parse(left.createdAt || "") || Number.MAX_SAFE_INTEGER;
  const rightCreated = Date.parse(right.createdAt || "") || Number.MAX_SAFE_INTEGER;
  return leftCreated - rightCreated || left.id.localeCompare(right.id);
}

function disambiguateProjectLabels(threads) {
  const byLabel = new Map();
  for (const thread of threads) {
    if (thread.groupKind === "other" || !thread.projectKey || !thread.projectLabel) continue;
    const projects = byLabel.get(thread.projectLabel) || new Map();
    projects.set(thread.projectKey, thread.workspaceRoot || thread.cwd);
    byLabel.set(thread.projectLabel, projects);
  }
  const labels = new Map();
  for (const [label, projects] of byLabel) {
    if (projects.size < 2) continue;
    const entries = [...projects.entries()];
    for (const [key, cwd] of entries) {
      const parentParts = path.dirname(cwd).split(path.sep).filter(Boolean);
      let qualifier = "";
      for (let depth = 1; depth <= Math.min(3, parentParts.length); depth += 1) {
        const candidate = parentParts.slice(-depth).join("/");
        const matches = entries.filter(([, other]) => path.dirname(other).split(path.sep).filter(Boolean).slice(-depth).join("/") === candidate);
        if (matches.length === 1) {
          qualifier = candidate;
          break;
        }
      }
      qualifier ||= key.slice(-4);
      const base = label.slice(0, Math.max(1, 117 - qualifier.length));
      labels.set(key, `${base} · ${qualifier}`.slice(0, 120));
    }
  }
  return threads.map((thread) => labels.has(thread.projectKey) ? { ...thread, projectLabel: labels.get(thread.projectKey) } : thread);
}

function disambiguateDisplayDuplicates(threads, roots) {
  const groups = new Map();
  for (const thread of threads) {
    const key = `${thread.projectKey || "other"}\u0000${thread.title}`;
    groups.set(key, [...(groups.get(key) || []), thread]);
  }
  return threads.map((thread) => {
    const group = groups.get(`${thread.projectKey || "other"}\u0000${thread.title}`) || [];
    if (group.length < 2) return thread;
    const stableGroup = [...group].sort((left, right) => (
      Number((roots.get(right.id) || right.id) === right.id) - Number((roots.get(left.id) || left.id) === left.id)
      || stableThreadOrder(left, right)
    ));
    const index = stableGroup.findIndex((item) => item.id === thread.id) + 1;
    const label = new Set(group.map((item) => roots.get(item.id) || item.id)).size === 1 ? "Fork" : "Session";
    return { ...thread, title: `${label} ${index} · ${thread.title}`.slice(0, 160) };
  });
}

export async function listThreads(limit = MAX_THREADS) {
  const [lineageRows, rows] = await Promise.all([
    query(`SELECT t.id, t.rollout_path FROM threads t`),
    query(`
    SELECT ${THREAD_COLUMNS}
    FROM threads t
    WHERE ${ROOT_THREAD_PREDICATE}
    ORDER BY t.recency_at_ms DESC, t.updated_at_ms DESC, t.id DESC`),
  ]);
  const workspaceState = readWorkspaceState();
  const { roots, ancestors } = lineageMetadata(dedupeRows(lineageRows));
  const threads = disambiguateProjectLabels(dedupeRows(rows)
    .map((row) => threadFromRow(row, workspaceState))
    .map((thread) => ({
      ...thread,
      lineageRootId: roots.get(thread.id) || thread.id,
      lineageAncestorIds: ancestors.get(thread.id) || [],
    })));
  return disambiguateDisplayDuplicates(threads, roots).slice(0, safeLimit(limit));
}

export async function findThread(id) {
  const canonicalId = String(id || "").trim();
  if (!canonicalId) return null;
  const rows = await query(`
    SELECT ${THREAD_COLUMNS}
    FROM threads t
    WHERE t.id = ${sqlString(canonicalId)}
      AND ${ROOT_THREAD_PREDICATE}
    LIMIT 1`);
  return rows[0] ? threadFromRow(rows[0], readWorkspaceState()) : null;
}
