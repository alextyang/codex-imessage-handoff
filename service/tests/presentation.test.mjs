import assert from "node:assert/strict";
import test from "node:test";
import { RelayClient } from "../src/relay-client.mjs";
import {
  parseMenuSelection,
  parseSlashCommand,
  relativeTime,
  renderContextFooter,
  renderHelp,
  renderOutboundEvent,
  renderThreadDirectory,
  renderThreadMenu,
  threadIdentityEmoji,
  threadTitle,
} from "../../protocol/presentation.ts";

const ACTIVE = {
  id: "active-thread",
  title: "Polish message formatting",
  projectKey: "handoff",
  projectLabel: "iMessage handoff",
};

const OTHER = {
  id: "other-thread",
  title: "Repair the crawler",
  projectKey: "crawler",
  projectLabel: "Music crawler",
};

const activeOptions = { context: { activeThread: ACTIVE } };

function assertExactFooter(rendered, thread = ACTIVE, label = "Active context") {
  const footer = renderContextFooter(thread, label);
  assert.ok(rendered.endsWith(`\n\n${footer}`), `expected exact footer:\n${footer}\n\nreceived:\n${rendered}`);
  assert.equal((rendered.match(/────────────/g) || []).length, 1, "renders one context divider");
}

test("thread object identities have a stable golden mapping across renames", () => {
  const canonical = {
    id: "019f57fb-22a8-7bf3-b62a-91b59d87c445",
    title: "Original title",
    projectLabel: "Project one",
  };
  const renamed = { ...canonical, title: "Renamed later", projectLabel: "Project two" };
  const different = { ...canonical, id: "019f53fb-fa53-7ed2-9393-6693c8e4b2e9" };

  assert.equal(threadIdentityEmoji(canonical), "📦");
  assert.equal(threadIdentityEmoji(renamed), "📦");
  assert.equal(threadIdentityEmoji(different), "📎");
  assert.equal(threadTitle(canonical), "📦 Original title");
  assert.match(threadIdentityEmoji({ title: "Fallback task", projectLabel: "Project" }), /\p{Extended_Pictographic}/u);
});

test("thread output uses Unicode hierarchy, preserves the body, and anchors context", () => {
  const body = "The tests pass.\n\nNext: deploy.";
  const rendered = renderOutboundEvent({ kind: "thread.output", thread: ACTIVE, body }, activeOptions);

  assert.ok(rendered.startsWith(`✓ CODEX · Result\n\n${threadTitle(ACTIVE)}\niMessage handoff\n\n${body}`));
  assertExactFooter(rendered);
  assert.doesNotMatch(rendered, /CODEX (?:CONTROL|THREAD|LIVE)|\[[A-Z ]+\]/);
});

test("directory separates projects, previews requests, and keeps recent projects compact", () => {
  const now = new Date("2026-07-12T08:00:00.000Z");
  const rendered = renderThreadDirectory({
    totalTasks: 4,
    criteria: "pending + activity in last 48h",
    groups: [
      {
        projectKey: "handoff",
        projectLabel: "iMessage handoff",
        threads: [
          { ...ACTIVE, index: 1, current: true, status: "working", stateSince: "2026-07-12T07:58:00.000Z", requestPreview: "Redo the message hierarchy." },
          { id: "pending", index: 2, title: "Verify notifications", status: "pending", pendingCount: 2, stateSince: "2026-07-12T07:55:00.000Z", requestPreview: "Check completion and presence notices." },
        ],
      },
      {
        projectKey: "other-tasks",
        projectLabel: "Other tasks",
        threads: [
          { id: "other", index: 3, title: "Compare providers", status: "idle", activityAt: "2026-07-12T06:00:00.000Z", requestPreview: "Which provider supports richer interactions?" },
        ],
      },
    ],
    collapsedProjects: [
      { index: 4, projectKey: "site", projectLabel: "Personal site", threadCount: 4, status: "idle", activityAt: "2026-07-12T07:00:00.000Z" },
    ],
    note: "Reply with a number to open.\n\n/recent · /search · /help",
  }, { now, ...activeOptions });

  assert.match(rendered, /^◆ CODEX · Threads\n\n4 tasks · pending \+ activity in last 48h · updated now/);
  assert.match(rendered, /▾ iMessage handoff · 2 tasks/);
  assert.match(rendered, new RegExp(`2  ${threadIdentityEmoji({ id: "pending", title: "Verify notifications" })} Verify notifications\\n   ◷ Pending · waiting 5m · 2 queued\\n   “Check completion and presence notices\\.”`));
  assert.match(rendered, /▾ Other tasks · 1 task/);
  assert.match(rendered, /Recent projects\n\n4  ▸ Personal site · 4 tasks\n   ○ Idle · 1h ago/);
  assert.match(rendered, /Reply\nReply with a number to open\.\n\nCommands\n\/recent · \/search · \/help/);
  assertExactFooter(rendered);
});

test("explicit directory context is footer-only and is not duplicated as a task row", () => {
  const rendered = renderThreadDirectory({
    groups: [{
      projectKey: "crawler",
      projectLabel: "Music crawler",
      threads: [
        { ...OTHER, index: 2, status: "pending" },
      ],
    }],
  }, activeOptions);
  const body = rendered.slice(0, rendered.lastIndexOf("\n\n────────────"));

  assert.doesNotMatch(body, new RegExp(`1  ${threadIdentityEmoji(ACTIVE)} Polish message formatting`));
  assert.match(body, new RegExp(`2  ${threadIdentityEmoji(OTHER)} Repair the crawler`));
  assertExactFooter(rendered);
});

test("projects menu rows are project affordances, not thread identities", () => {
  const items = [
    { id: "project-row-1", index: 1, title: "Music crawler", threadCount: 3, status: "working" },
    { id: "project-row-2", index: 2, title: "Personal site", threadCount: 2, status: "idle" },
  ];
  const rendered = renderThreadMenu(items, { label: "PROJECTS", ...activeOptions });
  const body = rendered.slice(0, rendered.lastIndexOf("\n\n────────────"));

  assert.match(body, /^◆ CODEX · Projects/);
  assert.match(body, /1  ▸ Browse Music crawler\n   3 tasks · ● Working/);
  assert.doesNotMatch(body, new RegExp(items.map((item) => threadIdentityEmoji(item)).join("|")));
  assertExactFooter(rendered);
});

test("thread detail exposes readable status, commands, request expansion, and full response", () => {
  const now = Date.now();
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: ACTIVE,
    state: "idle",
    activityAt: new Date(now - 5 * 60_000).toISOString(),
    reasoningEffort: "high",
    requestPreview: { body: "Normalize all album fields…", at: new Date(now - 7 * 60_000).toISOString(), truncated: true },
    assistantMessages: [{ body: "Full final response.\n\nAll 42 tests pass.", at: new Date(now - 5 * 60_000).toISOString(), phase: "final_answer" }],
  }, activeOptions);

  assert.match(rendered, /^◆ CODEX · Thread/);
  assert.match(rendered, /○ Idle · 5m ago · Reasoning: High/);
  assert.match(rendered, /Commands\n\/request · \/turn · \/history · \/reasoning/);
  assert.match(rendered, /Note · \/request shows the full message\./);
  assert.match(rendered, /Codex · Result · 5m ago\nFull final response\.\n\nAll 42 tests pass\./);
  assertExactFooter(rendered);
});

test("working and failed details retain their complete visible state", () => {
  const working = renderOutboundEvent({
    kind: "thread.detail",
    thread: ACTIVE,
    state: "working",
    stateSince: new Date(Date.now() - 2 * 60_000).toISOString(),
    requestPreview: { body: "Fix duplicate imports." },
    assistantMessages: [
      { body: "I found two discovery sources.", phase: "commentary" },
      { body: "The deduplication tests pass.", phase: "commentary" },
    ],
  }, activeOptions);
  assert.match(working, /● Working · for 2m/);
  assert.match(working, /I found two discovery sources\.[\s\S]*The deduplication tests pass\./);
  assert.match(working, /\/cancel · \/threads/);
  assertExactFooter(working);

  const failed = renderOutboundEvent({
    kind: "thread.detail",
    thread: ACTIVE,
    state: "error",
    requestPreview: { body: "Run the failed import again." },
  }, activeOptions);
  assert.match(failed, /▲ Error/);
  assert.match(failed, /Run the failed import again\./);
  assert.match(failed, /\/retry · \/dismiss · \/threads/);
  assert.match(failed, /did not produce a final response/);
  assertExactFooter(failed);
});

test("turn history and reasoning retain semantic labels in plain text", () => {
  const turn = renderOutboundEvent({
    kind: "thread.turn",
    thread: ACTIVE,
    turn: {
      request: "Review the service.",
      assistantMessages: [{ body: "I found one remaining issue.", phase: "commentary" }],
      finalResponse: "Fixed. All checks pass.",
      completedAt: new Date().toISOString(),
    },
  }, activeOptions);
  assert.match(turn, /You · now\nReview the service\.[\s\S]*Codex · Update · now\nI found one remaining issue\.[\s\S]*Codex · Result · now\nFixed\. All checks pass\./);
  assertExactFooter(turn);

  const history = renderOutboundEvent({
    kind: "thread.history",
    thread: ACTIVE,
    turns: [{ request: "Remove duplicates.", finalResponse: "Done. Two root tasks remain.", completedAt: new Date().toISOString() }],
  }, activeOptions);
  assert.match(history, /Turn 1 · now\nYou\nRemove duplicates\.[\s\S]*Codex\nDone\. Two root tasks remain\./);
  assertExactFooter(history);

  const reasoning = renderOutboundEvent({
    kind: "service.reasoning",
    thread: ACTIVE,
    current: "high",
    options: [{ value: "medium", label: "Medium" }, { value: "high", label: "High", selected: true }],
    note: "Applies to the next turn.",
  }, activeOptions);
  assert.match(reasoning, /^◆ CODEX · Reasoning/);
  assert.match(reasoning, /Current · High/);
  assert.match(reasoning, /Options\n○ Medium\n   \/reasoning medium\n\n● High · selected\n   \/reasoning high/);
  assertExactFooter(reasoning);
});

test("unrelated completion names its source while preserving the current context", () => {
  const completion = renderOutboundEvent({
    kind: "thread.completed",
    completionId: "completion-presentation",
    thread: OTHER,
    completedAt: new Date().toISOString(),
    body: "Crawler repaired and verified.",
  }, activeOptions);

  assert.ok(completion.startsWith(`✓ CODEX · Completed Elsewhere\n\n${threadTitle(OTHER)}\nMusic crawler\n✓ Completed · now\n\nCrawler repaired and verified.`));
  assertExactFooter(completion, ACTIVE, "Active context unchanged");
  assert.doesNotMatch(completion, /Now active/);
});

test("mirrored local messages disclose provenance and assistant updates stay distinct", () => {
  const mirrored = renderOutboundEvent({
    kind: "thread.live-message",
    messageId: "live-user-1",
    thread: ACTIVE,
    role: "user",
    phase: "user_message",
    body: "Show this local message remotely.",
  }, activeOptions);
  assert.ok(mirrored.startsWith("You · Mirrored from Mac · now\n\nShow this local message remotely."));
  assertExactFooter(mirrored);

  const commentary = renderOutboundEvent({
    kind: "thread.live-message",
    messageId: "live-codex-1",
    thread: ACTIVE,
    role: "assistant",
    phase: "commentary",
    body: "I found the relay path and I’m checking delivery.",
  }, activeOptions);
  assert.ok(commentary.startsWith("Codex · Update · now\n\nI found the relay path and I’m checking delivery."));
  assertExactFooter(commentary);
});

test("switches use a Now active footer and explain fork following", () => {
  const fork = { ...OTHER, id: "fork-2", title: "Continue implementation" };
  const switched = renderOutboundEvent({ kind: "service.switched", reason: "fork", thread: fork }, activeOptions);

  assert.match(switched, /^↪ CODEX · Following Fork/);
  assert.match(switched, /New messages now go to the active fork of this task\./);
  assertExactFooter(switched, fork, "Now active");

  const manual = renderOutboundEvent({ kind: "service.switched", thread: OTHER }, activeOptions);
  assert.match(manual, /^↪ CODEX · Context Switched/);
  assert.match(manual, /New messages now go to this task\./);
  assertExactFooter(manual, OTHER, "Now active");
});

test("every outbound event class ends with the exact current-context footer", async (t) => {
  const cases = [
    ["thread.output", { kind: "thread.output", thread: ACTIVE, body: "Done." }, "Active context"],
    ["thread.completed", { kind: "thread.completed", completionId: "c1", thread: ACTIVE, body: "Done." }, "Active context"],
    ["thread.live-message", { kind: "thread.live-message", messageId: "m1", thread: ACTIVE, role: "assistant", body: "Working." }, "Active context"],
    ["thread.progress", { kind: "thread.progress", thread: ACTIVE, phase: "Running checks." }, "Active context"],
    ["thread.detail", { kind: "thread.detail", thread: ACTIVE, state: "idle" }, "Active context"],
    ["thread.request", { kind: "thread.request", thread: ACTIVE, body: "Review this." }, "Active context"],
    ["thread.turn", { kind: "thread.turn", thread: ACTIVE, turn: null }, "Active context"],
    ["thread.history", { kind: "thread.history", thread: ACTIVE, turns: [] }, "Active context"],
    ["service.reasoning", { kind: "service.reasoning", thread: ACTIVE, options: ["medium"] }, "Active context"],
    ["service.menu", { kind: "service.menu", label: "COMMANDS", body: "/threads · List tasks" }, "Active context"],
    ["service.directory", { kind: "service.directory", directory: { groups: [] } }, "Active context"],
    ["service.switched", { kind: "service.switched", thread: ACTIVE }, "Now active"],
    ["service.presence", { kind: "service.presence", state: "online" }, "Active context unchanged"],
    ["service.notice", { kind: "service.notice", code: "updated", body: "Settings saved.", thread: ACTIVE }, "Active context"],
  ];

  for (const [name, event, label] of cases) {
    await t.test(name, () => {
      const rendered = renderOutboundEvent(event, activeOptions);
      assertExactFooter(rendered, ACTIVE, label);
    });
  }
});

test("global messages explicitly say when there is no active task", () => {
  const noActiveOptions = { context: { activeThread: null } };
  const help = renderHelp(noActiveOptions);
  const presence = renderOutboundEvent({ kind: "service.presence", state: "offline" }, noActiveOptions);

  assert.match(help, /^◆ CODEX · Commands/);
  assertExactFooter(help, null);
  assert.match(presence, /^× CODEX · Mac Disconnected/);
  assertExactFooter(presence, null);
  assert.ok(help.endsWith("────────────\n⌁ No active task · /threads"));
});

test("Unicode structure retains plain semantic words for reading and search", () => {
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: ACTIVE,
    state: "working",
    assistantMessages: [{ body: "Checking the format.", phase: "commentary" }],
  }, activeOptions);

  assert.match(rendered, /◆ CODEX · Thread/);
  assert.match(rendered, /● Working/);
  assert.match(rendered, /Codex · Update/);
  assert.match(rendered, /⌁ Active context/);
  assert.doesNotMatch(rendered, /[\u{1D400}-\u{1D7FF}]/u, "does not replace semantic words with mathematical alphanumeric glyphs");
});

test("legacy menus remain grouped and selection syntax is stable", () => {
  const rendered = renderThreadMenu([
    { id: "service", title: "Service redesign", projectLabel: "iMessage handoff", current: true, status: "idle" },
    { id: "crawler", title: "Music crawler", projectLabel: "Crawler", status: "pending" },
  ]);
  assert.match(rendered, /▾ iMessage handoff · 1 task/);
  assert.match(rendered, new RegExp(`1  ${threadIdentityEmoji({ id: "service", title: "Service redesign" })} Service redesign`));
  assert.match(rendered, /▾ Crawler · 1 task/);
  assert.deepEqual(parseMenuSelection("2"), { index: 1, prompt: null });
  assert.deepEqual(parseMenuSelection("2: run the tests"), { index: 1, prompt: "run the tests" });
  assert.equal(parseMenuSelection("status"), null);
});

test("relative recency and local-control commands parse without consuming ordinary text", () => {
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
  assert.match(renderHelp(), /Browse[\s\S]*Active task[\s\S]*Work[\s\S]*Menu replies/);
  assert.match(renderHelp(), /\/refresh · Refresh the task list/);
  assert.match(renderHelp(), /\/retry · Retry the oldest failed request/);
});

test("relay client advertises live mirroring and follows tasks with compare-and-set", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, switched: true, currentThreadId: "fork-2" }), { status: 200 });
  };
  try {
    const relay = new RelayClient({ apiBaseUrl: "https://relay.test", token: "secret", clientId: "client-1" });
    await relay.register();
    await relay.followThread("fork-2", "thread-1");
    assert.ok(calls[0].body.capabilities.includes("live-mirror-v1"));
    assert.deepEqual(calls[1], {
      url: "https://relay.test/service/active-thread",
      body: { threadId: "fork-2", expectedThreadId: "thread-1" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
