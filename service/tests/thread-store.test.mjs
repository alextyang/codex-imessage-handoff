import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findThread, listThreads, projectKey, projectLabel } from "../src/thread-store.mjs";

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function history(turnId, state) {
  const rows = [
    { timestamp: "2026-07-12T03:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId, started_at: 1_783_824_400_000 } },
    { timestamp: "2026-07-12T03:00:00.010Z", type: "response_item", payload: { type: "message", role: "user", internal_chat_message_metadata_passthrough: { turn_id: turnId }, content: [{ type: "input_text", text: "Fixture request" }] } },
  ];
  if (state === "idle") rows.push({ timestamp: "2026-07-12T03:00:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId, completed_at: 1_783_824_401_000, last_agent_message: "Fixture response" } });
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("catalog excludes subagents, groups projects, carries state, and finds IDs beyond a menu limit", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-store-"));
  const database = path.join(directory, "state.sqlite");
  const globalState = path.join(directory, "global-state.json");
  const project = path.join(directory, "projects", "catalog-app");
  const sameNameProject = path.join(directory, "copies", "catalog-app");
  const idleRollout = path.join(directory, "idle.jsonl");
  const runningRollout = path.join(directory, "running.jsonl");
  writeFileSync(idleRollout, history("turn-idle", "idle"));
  writeFileSync(runningRollout, history("turn-running", "running"));
  const forkRootRollout = path.join(directory, "fork-root.jsonl");
  const forkCopyRollout = path.join(directory, "fork-copy.jsonl");
  const hiddenForkRootRollout = path.join(directory, "fork-hidden-root.jsonl");
  const hiddenForkARollout = path.join(directory, "fork-hidden-a.jsonl");
  const hiddenForkBRollout = path.join(directory, "fork-hidden-b.jsonl");
  const ancestryRootRollout = path.join(directory, "ancestry-root.jsonl");
  const ancestryHiddenRollout = path.join(directory, "ancestry-hidden.jsonl");
  const ancestryGrandchildRollout = path.join(directory, "ancestry-grandchild.jsonl");
  writeFileSync(forkRootRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "fork-root" } })}\n`);
  writeFileSync(forkCopyRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "fork-copy", forked_from_id: "fork-root" } })}\n`);
  writeFileSync(hiddenForkRootRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "fork-hidden-root" } })}\n`);
  writeFileSync(hiddenForkARollout, `${JSON.stringify({ type: "session_meta", payload: { id: "fork-hidden-a", forked_from_id: "fork-hidden-root" } })}\n`);
  writeFileSync(hiddenForkBRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "fork-hidden-b", forked_from_id: "fork-hidden-root" } })}\n`);
  writeFileSync(ancestryRootRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "ancestry-root" } })}\n`);
  writeFileSync(ancestryHiddenRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "ancestry-hidden", forked_from_id: "ancestry-root" } })}\n`);
  writeFileSync(ancestryGrandchildRollout, `${JSON.stringify({ type: "session_meta", payload: { id: "ancestry-grandchild", forked_from_id: "ancestry-hidden" } })}\n`);

  const rows = [];
  for (let index = 0; index < 125; index += 1) {
    const id = `root-${String(index).padStart(3, "0")}`;
    const rollout = index === 0 ? runningRollout : index === 124 ? idleRollout : path.join(directory, `${id}.jsonl`);
    rows.push({
      id,
      rollout,
      title: `Root ${index}`,
      cwd: project,
      source: "vscode",
      threadSource: "user",
      recency: 1_783_824_500_000 - index,
      model: index === 0 ? "gpt-fixture" : null,
      reasoning: index === 0 ? "high" : null,
    });
  }
  rows.push(
    { id: "child-edge", rollout: path.join(directory, "child-edge.jsonl"), title: "Root 0", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_600_000 },
    { id: "child-source", rollout: path.join(directory, "child-source.jsonl"), title: "Root 0", cwd: project, source: '{"subagent":{"thread_spawn":{}}}', threadSource: null, recency: 1_783_824_600_001 },
    { id: "child-marker", rollout: path.join(directory, "child-marker.jsonl"), title: "Root 0", cwd: project, source: "vscode", threadSource: "subagent", recency: 1_783_824_600_002 },
    { id: "automated-exec", rollout: path.join(directory, "automated-exec.jsonl"), title: "Reply with exactly OK", cwd: project, source: "exec", threadSource: null, recency: 1_783_824_600_003 },
    { id: "fork-root", rollout: forkRootRollout, title: "Indistinguishable fork", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_300_000 },
    { id: "fork-copy", rollout: forkCopyRollout, title: "Indistinguishable fork", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_300_001 },
    { id: "fork-hidden-root", rollout: hiddenForkRootRollout, title: "Hidden ancestor", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_100_000, archived: true },
    { id: "fork-hidden-a", rollout: hiddenForkARollout, title: "Hidden-parent fork", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_200_000 },
    { id: "fork-hidden-b", rollout: hiddenForkBRollout, title: "Hidden-parent fork", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_200_001 },
    { id: "ancestry-root", rollout: ancestryRootRollout, title: "Ancestry root", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_190_000 },
    { id: "ancestry-hidden", rollout: ancestryHiddenRollout, title: "Archived intermediate", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_190_001, archived: true },
    { id: "ancestry-grandchild", rollout: ancestryGrandchildRollout, title: "Visible grandchild", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_190_002 },
    { id: "session-a", rollout: path.join(directory, "session-a.jsonl"), title: "Separate conversation", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_150_000 },
    { id: "session-b", rollout: path.join(directory, "session-b.jsonl"), title: "Separate conversation", cwd: project, source: "vscode", threadSource: "user", recency: 1_783_824_150_001 },
    { id: "same-name-project", rollout: path.join(directory, "same-name-project.jsonl"), title: "Other checkout", cwd: sameNameProject, source: "vscode", threadSource: "user", recency: 1_783_824_140_000 },
    { id: "projectless-a", rollout: path.join(directory, "projectless-a.jsonl"), title: "General question A", cwd: path.join(directory, "generated", "a"), source: "vscode", threadSource: "user", recency: 1_783_824_130_000 },
    { id: "projectless-b", rollout: path.join(directory, "projectless-b.jsonl"), title: "General question B", cwd: path.join(directory, "generated", "b"), source: "vscode", threadSource: "user", recency: 1_783_824_120_000 },
    { id: "hinted-worktree", rollout: path.join(directory, "hinted-worktree.jsonl"), title: "Canonical project", cwd: path.join(directory, "worktrees", "catalog-app"), source: "vscode", threadSource: "user", recency: 1_783_824_110_000 },
  );

  writeFileSync(globalState, JSON.stringify({
    "projectless-thread-ids": ["projectless-a", "projectless-b"],
    "thread-workspace-root-hints": { "hinted-worktree": project },
  }));

  const statements = [
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL,
      archived INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      created_at_ms INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER,
      preview TEXT NOT NULL, model TEXT, reasoning_effort TEXT, model_provider TEXT NOT NULL,
      git_origin_url TEXT, git_branch TEXT, source TEXT NOT NULL, thread_source TEXT
    );`,
    "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);",
    ...rows.map((row) => `INSERT INTO threads VALUES (
      ${sql(row.id)}, ${sql(row.rollout)}, ${sql(row.title)}, ${sql(row.cwd)}, ${row.archived ? 1 : 0},
      1783824000, 1783824001, 1783824000000, 1783824001000,
      ${sql(Math.floor(row.recency / 1000))}, ${sql(row.recency)}, 'visible',
      ${sql(row.model)}, ${sql(row.reasoning)}, 'openai', NULL, NULL,
      ${sql(row.source)}, ${sql(row.threadSource)}
    );`),
    "UPDATE threads SET created_at = 1, created_at_ms = 1000 WHERE id = 'fork-hidden-root';",
    "INSERT INTO thread_spawn_edges VALUES ('root-000','child-edge','closed');",
  ];
  execFileSync("sqlite3", [database], { input: statements.join("\n") });

  const previous = process.env.IMESSAGE_HANDOFF_STATE_DB;
  const previousGlobalState = process.env.IMESSAGE_HANDOFF_GLOBAL_STATE;
  process.env.IMESSAGE_HANDOFF_STATE_DB = database;
  process.env.IMESSAGE_HANDOFF_GLOBAL_STATE = globalState;
  try {
    const all = await listThreads(999);
    assert.equal(all.length, 137);
    assert.equal(new Set(all.map((thread) => thread.id)).size, 137);
    assert.equal(all.some((thread) => thread.id.startsWith("child-")), false);
    assert.equal(all.some((thread) => thread.id === "automated-exec"), false);
    assert.equal(all.find((thread) => thread.id === "fork-root")?.title, "Fork 1 · Indistinguishable fork");
    assert.equal(all.find((thread) => thread.id === "fork-copy")?.title, "Fork 2 · Indistinguishable fork");
    assert.equal(all.find((thread) => thread.id === "fork-hidden-a")?.title, "Fork 1 · Hidden-parent fork");
    assert.equal(all.find((thread) => thread.id === "fork-hidden-b")?.title, "Fork 2 · Hidden-parent fork");
    assert.equal(all.some((thread) => thread.id === "fork-hidden-root"), false);
    assert.equal(all.find((thread) => thread.id === "fork-copy")?.lineageRootId, "fork-root");
    assert.equal(all.find((thread) => thread.id === "fork-hidden-a")?.lineageRootId, "fork-hidden-root");
    assert.equal(all.find((thread) => thread.id === "session-a")?.lineageRootId, "session-a");
    assert.deepEqual(all.find((thread) => thread.id === "fork-copy")?.lineageAncestorIds, ["fork-root"]);
    assert.deepEqual(all.find((thread) => thread.id === "ancestry-root")?.lineageAncestorIds, []);
    assert.deepEqual(all.find((thread) => thread.id === "ancestry-grandchild")?.lineageAncestorIds, ["ancestry-hidden", "ancestry-root"]);
    assert.equal(all.some((thread) => thread.id === "ancestry-hidden"), false);
    assert.equal(all.find((thread) => thread.id === "session-a")?.title, "Session 1 · Separate conversation");
    assert.equal(all.find((thread) => thread.id === "session-b")?.title, "Session 2 · Separate conversation");
    assert.equal(new Set(all.map((thread) => `${thread.cwd}\u0000${thread.title}`)).size, all.length);
    assert.equal(all[0].id, "root-000");
    assert.equal(all[0].state, "running");
    assert.equal(all[0].model, "gpt-fixture");
    assert.equal(all[0].reasoningEffort, "high");
    assert.equal(all[0].rolloutPath, runningRollout);
    assert.equal(all[0].createdAt, "2026-07-12T02:40:00.000Z");
    assert.equal(all[0].projectLabel, "catalog-app · projects");
    assert.equal(all.find((thread) => thread.id === "same-name-project")?.projectLabel, "catalog-app · copies");
    assert.equal(all[0].projectKey, projectKey(project));
    assert.equal(all[0].projectStartedAt, "1970-01-01T00:00:01.000Z");
    assert.equal(all[0].lastTurnAt, "2026-07-12T03:00:00.010Z");
    assert.equal(all.find((thread) => thread.id === "hinted-worktree")?.projectKey, projectKey(project));
    assert.equal(all.find((thread) => thread.id === "hinted-worktree")?.workspaceRoot, project);
    assert.equal(all.find((thread) => thread.id === "projectless-a")?.projectKey, null);
    assert.equal(all.find((thread) => thread.id === "projectless-a")?.projectLabel, null);
    assert.equal(all.find((thread) => thread.id === "projectless-a")?.groupKind, "other");
    assert.equal(all.find((thread) => thread.id === "projectless-b")?.groupKind, "other");
    assert.equal(projectLabel(`${project}${path.sep}`), "catalog-app");
    assert.equal(projectLabel(path.join(directory, "x".repeat(180))).length, 120);

    const one = await listThreads(1);
    assert.deepEqual(one.map((thread) => thread.id), ["root-000"]);
    const outsideMenu = await findThread("root-124");
    assert.equal(outsideMenu.id, "root-124");
    assert.equal(outsideMenu.state, "idle");
    assert.equal(await findThread("child-edge"), null);
    assert.equal(await findThread("missing"), null);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_STATE_DB;
    else process.env.IMESSAGE_HANDOFF_STATE_DB = previous;
    if (previousGlobalState === undefined) delete process.env.IMESSAGE_HANDOFF_GLOBAL_STATE;
    else process.env.IMESSAGE_HANDOFF_GLOBAL_STATE = previousGlobalState;
  }
});
