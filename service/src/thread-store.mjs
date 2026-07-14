import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, openSync, closeSync, readSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { servicePaths } from "./paths.mjs";
import { readSidebarTitleIndex } from "./sidebar-title-index.mjs";
import { getThreadState } from "./thread-history.mjs";
import { readWorkspaceState } from "./workspace-state.mjs";

const execFileAsync = promisify(execFile);
const MAX_THREADS = 500;
const SQLITE_BUSY_TIMEOUT_MS = 2_000;
const SQLITE_QUERY_ATTEMPTS = 4;
const SQLITE_RETRY_BASE_MS = 50;

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

const USER_THREAD_PREDICATE = `
  t.source <> 'exec'
  AND COALESCE(t.thread_source, '') <> 'subagent'
  AND t.source NOT LIKE '%"subagent"%'
  AND NOT EXISTS (
    SELECT 1 FROM thread_spawn_edges edge WHERE edge.child_thread_id = t.id
  )`;

const ROOT_THREAD_PREDICATE = `
  t.archived = 0
  AND t.preview <> ''
  AND ${USER_THREAD_PREDICATE}`;

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
  t.thread_source,
  t.model,
  t.reasoning_effort,
  t.model_provider,
  t.git_origin_url,
  t.git_branch`;

function retryableSqliteError(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /database is locked|database is busy|unable to open database file|SQLITE_BUSY|SQLITE_CANTOPEN/i.test(text);
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queryWithRetry(database, sql, options = {}) {
  const execute = options.execute || execFileAsync;
  const wait = options.wait || pause;
  const attempts = Math.max(1, Number(options.attempts) || SQLITE_QUERY_ATTEMPTS);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { stdout } = await execute("sqlite3", [
        "-readonly",
        "-json",
        "-cmd",
        `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
        database,
        sql,
      ], { maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim() ? JSON.parse(stdout) : [];
    } catch (error) {
      lastError = error;
      if (!retryableSqliteError(error) || attempt + 1 >= attempts) throw error;
      await wait(SQLITE_RETRY_BASE_MS * (2 ** attempt));
    }
  }
  throw lastError;
}

async function query(sql) {
  const database = servicePaths().stateDb;
  if (!existsSync(database)) throw new Error(`Codex state database not found: ${database}`);
  return queryWithRetry(database, sql);
}

function threadFromRow(row, workspaceState = readWorkspaceState(), sidebarTitles = new Map()) {
  const id = String(row.id);
  const sidebarTitle = sidebarTitles.get(id) || null;
  const cwd = normalizedCwd(row.cwd);
  const serviceProjectless = /^imessage-handoff:new:[a-f0-9]{32}:other$/i.test(String(row.thread_source || ""));
  const projectless = workspaceState.projectlessThreadIds.has(id) || serviceProjectless;
  const hintedRoot = workspaceState.workspaceRootHints.get(id);
  const workspaceRoot = projectless ? null : normalizedCwd(hintedRoot || cwd);
  const updatedAt = iso(row.updated_at_ms, row.updated_at);
  const recencyAt = iso(row.recency_at_ms, row.recency_at) || updatedAt;
  const observed = getThreadState(String(row.rollout_path || ""));
  const forkedFromId = forkParent(String(row.rollout_path || ""));
  const activityAt = observed.activityAt || updatedAt || recencyAt;
  return {
    id,
    // SQLite `threads.title` is the first request text in current Codex
    // builds, not the title shown in the sidebar. Never surface it as a name.
    title: sidebarTitle || "Untitled task",
    sidebarTitle,
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
    threadSource: typeof row.thread_source === "string" && row.thread_source ? row.thread_source : null,
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

export const threadStoreInternals = Object.freeze({
  queryWithRetry,
  retryableSqliteError,
  sqliteBusyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
  sqliteQueryAttempts: SQLITE_QUERY_ATTEMPTS,
});

export async function listThreads(limit = MAX_THREADS) {
  const paths = servicePaths();
  const [lineageRows, rows, projectRows, sidebarTitles] = await Promise.all([
    query(`SELECT t.id, t.rollout_path FROM threads t`),
    query(`
    SELECT ${THREAD_COLUMNS}
    FROM threads t
    WHERE ${ROOT_THREAD_PREDICATE}
    ORDER BY t.recency_at_ms DESC, t.updated_at_ms DESC, t.id DESC`),
    query(`
    SELECT t.id, t.cwd, t.created_at, t.created_at_ms
    FROM threads t
    WHERE ${USER_THREAD_PREDICATE}`),
    readSidebarTitleIndex(paths.sessionIndex),
  ]);
  const workspaceState = readWorkspaceState();
  const { roots, ancestors } = lineageMetadata(dedupeRows(lineageRows));
  const projectStartedAt = new Map();
  for (const row of dedupeRows(projectRows)) {
    const id = String(row.id || "");
    if (!id || workspaceState.projectlessThreadIds.has(id)) continue;
    const workspaceRoot = normalizedCwd(workspaceState.workspaceRootHints.get(id) || row.cwd);
    const key = projectKey(workspaceRoot);
    const startedAt = iso(row.created_at_ms, row.created_at);
    const startedAtMs = Date.parse(startedAt || "");
    if (!Number.isFinite(startedAtMs)) continue;
    const current = Date.parse(projectStartedAt.get(key) || "");
    if (!Number.isFinite(current) || startedAtMs < current) projectStartedAt.set(key, startedAt);
  }
  const threads = disambiguateProjectLabels(dedupeRows(rows)
    .map((row) => threadFromRow(row, workspaceState, sidebarTitles))
    .map((thread) => ({
      ...thread,
      projectStartedAt: thread.projectKey ? projectStartedAt.get(thread.projectKey) || thread.createdAt : null,
      lineageRootId: roots.get(thread.id) || thread.id,
      lineageAncestorIds: ancestors.get(thread.id) || [],
    })));
  return threads.slice(0, safeLimit(limit));
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
  if (!rows[0]) return null;
  const sidebarTitles = await readSidebarTitleIndex(servicePaths().sessionIndex);
  return threadFromRow(rows[0], readWorkspaceState(), sidebarTitles);
}

export async function findThreadBySource(source) {
  const canonicalSource = String(source || "").trim();
  if (!canonicalSource) return null;
  const rows = await query(`
    SELECT ${THREAD_COLUMNS}
    FROM threads t
    WHERE COALESCE(t.thread_source, '') = ${sqlString(canonicalSource)}
      AND t.archived = 0
      AND ${USER_THREAD_PREDICATE}
    ORDER BY t.created_at_ms ASC, t.created_at ASC, t.id ASC
    LIMIT 1`);
  if (!rows[0]) return null;
  const sidebarTitles = await readSidebarTitleIndex(servicePaths().sessionIndex);
  return threadFromRow(rows[0], readWorkspaceState(), sidebarTitles);
}
