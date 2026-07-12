import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMenuSelection,
  parseSlashCommand,
  relativeTime,
  renderHelp,
  renderOutboundEvent,
  renderThreadDirectory,
  renderThreadMenu,
} from "../../protocol/presentation.ts";

test("thread output has a distinct project/task namespace without modifying its body", () => {
  const body = "The tests pass.\n\nNext: deploy.";
  assert.equal(renderOutboundEvent({
    kind: "thread.output",
    thread: { title: "Fix metadata", projectLabel: "Music crawler" },
    body,
  }), `CODEX THREAD · MUSIC CRAWLER\nFix metadata\n\n${body}`);
});

test("grouped directory expands task rows and keeps recent projects compact", () => {
  const now = new Date("2026-07-12T08:00:00.000Z");
  const rendered = renderThreadDirectory({
    groups: [
      {
        projectKey: "music",
        projectLabel: "Music crawler",
        threadCount: 3,
        hiddenCount: 1,
        threads: [
          { index: 1, title: "Fix album metadata", current: true, status: "idle", activityAt: "2026-07-12T07:55:00.000Z" },
          { index: 2, title: "Retry imports", status: "working", stateSince: "2026-07-12T07:58:00.000Z" },
        ],
      },
    ],
    collapsedProjects: [
      { index: 3, projectKey: "site", projectLabel: "Personal site", threadCount: 4, status: "idle", activityAt: "2026-07-12T07:00:00.000Z" },
    ],
    note: "Reply with a number to open.  /recent · /search · /help",
  }, { now });

  assert.equal(rendered, [
    "CODEX CONTROL · THREADS",
    "7 tasks · refreshed now",
    "MUSIC CRAWLER\n1. Fix album metadata\n   Selected · Idle · 5m ago\n2. Retry imports\n   Working · 2m\n   +1 more task",
    "RECENT PROJECTS\n3. Personal site\n   4 tasks · 1h ago",
    "Reply with a number to open.  /recent · /search · /help",
  ].join("\n\n"));
});

test("thread detail exposes state, commands, request expansion, and the full final response", () => {
  const now = Date.now();
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: { title: "Fix album metadata", projectLabel: "Music crawler" },
    state: "idle",
    activityAt: new Date(now - 5 * 60_000).toISOString(),
    reasoningEffort: "high",
    requestPreview: { body: "Normalize all album fields…", at: new Date(now - 7 * 60_000).toISOString(), truncated: true },
    assistantMessages: [{ body: "Full final response.\n\nAll 42 tests pass.", at: new Date(now - 5 * 60_000).toISOString() }],
  });
  assert.match(rendered, /^CODEX THREAD · MUSIC CRAWLER\nFix album metadata/);
  assert.match(rendered, /Idle · 5m ago · Reasoning High/);
  assert.match(rendered, /\/request · \/turn · \/history · \/reasoning/);
  assert.match(rendered, /\/request shows the full message/);
  assert.match(rendered, /Full final response\.\n\nAll 42 tests pass\.$/);
});

test("working detail includes every visible message from the current turn", () => {
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: { title: "Retry imports", projectLabel: "Music crawler" },
    state: "working",
    stateSince: new Date(Date.now() - 2 * 60_000).toISOString(),
    requestPreview: { body: "Fix duplicate imports." },
    assistantMessages: [
      { body: "I found two discovery sources." },
      { body: "The deduplication tests pass." },
    ],
  });
  assert.match(rendered, /Working · 2m/);
  assert.match(rendered, /I found two discovery sources\.[\s\S]*The deduplication tests pass\./);
  assert.match(rendered, /\/cancel · \/threads/);
});

test("failed detail keeps the request visible and offers retry", () => {
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: { title: "Retry imports", projectLabel: "Music crawler" },
    state: "error",
    requestPreview: { body: "Run the failed import again." },
  });
  assert.match(rendered, /Error · unknown/);
  assert.match(rendered, /Run the failed import again\./);
  assert.match(rendered, /\/retry · \/dismiss · \/threads/);
  assert.match(rendered, /did not produce a final response/);
});

test("history renders exact final responses and reasoning is a command menu", () => {
  const turn = renderOutboundEvent({
    kind: "thread.turn",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    turn: {
      request: "Review the service.",
      assistantMessages: [{ body: "I found one remaining issue." }],
      finalResponse: "Fixed. All checks pass.",
      completedAt: new Date().toISOString(),
    },
  });
  assert.match(turn, /I found one remaining issue\.[\s\S]*Fixed\. All checks pass\./);

  const history = renderOutboundEvent({
    kind: "thread.history",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    turns: [{ request: "Remove duplicates.", finalResponse: "Done. Two root tasks remain.", completedAt: new Date().toISOString() }],
  });
  assert.match(history, /YOU\nRemove duplicates\.[\s\S]*CODEX\nDone\. Two root tasks remain\./);

  const reasoning = renderOutboundEvent({
    kind: "service.reasoning",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    current: "high",
    options: [{ value: "medium", label: "Medium" }, { value: "high", label: "High", selected: true }],
    note: "Applies to the next turn.",
  });
  assert.match(reasoning, /^CODEX CONTROL · REASONING/);
  assert.match(reasoning, /• High  · \/reasoning high/);

  const reset = renderOutboundEvent({
    kind: "service.reasoning",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    current: "medium",
    changed: true,
    options: [
      { value: "default", label: "Use task default", selected: true },
      { value: "medium", label: "Medium", selected: false },
    ],
  });
  assert.match(reset, /Changed: Task default · Medium\./);
  assert.equal((reset.match(/•/g) || []).length, 1);
});

test("legacy menus remain grouped and selection syntax is snapshot friendly", () => {
  const rendered = renderThreadMenu([
    { title: "Service redesign", projectLabel: "imessage", current: true, status: "idle" },
    { title: "Music crawler", projectLabel: "crawler", status: "pending" },
  ]);
  assert.match(rendered, /IMESSAGE\n1\. Service redesign/);
  assert.match(rendered, /CRAWLER\n2\. Music crawler/);
  assert.deepEqual(parseMenuSelection("2"), { index: 1, prompt: null });
  assert.deepEqual(parseMenuSelection("2: run the tests"), { index: 1, prompt: "run the tests" });
  assert.equal(parseMenuSelection("status"), null);
});

test("relative recency and all local-control commands parse without consuming ordinary text", () => {
  const now = new Date("2026-07-12T08:00:00.000Z");
  assert.equal(relativeTime("2026-07-12T07:55:00.000Z", now), "5m ago");
  assert.deepEqual(parseSlashCommand("/search music crawler"), { command: "search", argument: "music crawler" });
  assert.deepEqual(parseSlashCommand("/history 4"), { command: "history", argument: "4" });
  assert.deepEqual(parseSlashCommand("/reasoning xhigh"), { command: "reasoning", argument: "xhigh" });
  assert.deepEqual(parseSlashCommand("/request"), { command: "request", argument: null });
  assert.deepEqual(parseSlashCommand("/dismiss"), { command: "dismiss", argument: null });
  assert.deepEqual(parseSlashCommand("/refresh"), { command: "refresh", argument: null });
  assert.equal(parseSlashCommand("threads"), null);
  assert.equal(parseSlashCommand("status"), null);
  assert.match(renderHelp(), /^CODEX CONTROL · COMMANDS/);
});
