import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync } from "node:fs";
import { servicePaths } from "./paths.mjs";

const execFileAsync = promisify(execFile);

function iso(ms, seconds) {
  const value = Number(ms) || Number(seconds) * 1000;
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : new Date().toISOString();
}

function projectLabel(cwd) {
  return String(cwd || "Codex").split(path.sep).filter(Boolean).at(-1) || "Codex";
}

export async function listThreads(limit = 100) {
  const database = servicePaths().stateDb;
  if (!existsSync(database)) throw new Error(`Codex state database not found: ${database}`);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  const sql = `SELECT id,title,cwd,archived,created_at,updated_at,created_at_ms,updated_at_ms,preview FROM threads WHERE archived = 0 AND preview <> '' ORDER BY recency_at_ms DESC, updated_at_ms DESC LIMIT ${safeLimit}`;
  const { stdout } = await execFileAsync("sqlite3", ["-json", database, sql], { maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout.trim() ? JSON.parse(stdout) : [];
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title || "Untitled thread").replace(/\s+/g, " ").trim().slice(0, 120),
    cwd: String(row.cwd || "Codex"),
    projectLabel: projectLabel(row.cwd),
    createdAt: iso(row.created_at_ms, row.created_at),
    updatedAt: iso(row.updated_at_ms, row.updated_at),
    archived: Boolean(row.archived),
    visible: Boolean(row.preview),
  }));
}

export async function findThread(id) {
  return (await listThreads(100)).find((thread) => thread.id === id) || null;
}
