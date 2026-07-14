import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMenuSelection,
  projectIdentityEmoji,
  renderHelp,
  renderOutboundEvent,
  renderOutboundMessages,
  renderThreadHeader,
  renderThreadDirectory,
  renderThreadMenu,
  threadIdentityEmoji,
} from "../../protocol/presentation.ts";

const ACTIVE = {
  id: "active-thread",
  title: "Polish message formatting",
  createdAt: "2026-07-12T07:00:00.000Z",
  projectKey: "handoff",
  projectLabel: "iMessage handoff",
};

const OTHER = {
  id: "other-thread",
  title: "Repair the crawler",
  createdAt: "2026-07-11T08:00:00.000Z",
  projectKey: "crawler",
  projectLabel: "Music crawler",
};

const activeOptions = { context: { activeThread: ACTIVE } };

test("help is the minimal task, tapback, and settings reference", () => {
  assert.equal(renderHelp(), [
    "**Browse**",
    "/new (message) · Start a task",
    "/threads · Tasks by project",
    "/refresh · Refresh the task list",
    "/search (query) · Find a task",
    "/projects · Browse all projects",
    "",
    "**Task controls**",
    "👍 add/remove · Listen for the next turn’s live updates",
    "👎 add/remove · Mute or unmute automatic updates",
    "❓ add · Show status, current turn, and recent history",
    "/thread · Status and latest response",
    "/turn · Show current or last turn",
    "/history (length) · Completed turn history",
    "/reasoning (level/none) · View or change reasoning",
    "/link · Show the Codex task link",
    "/cancel · Stop iMessage-started work in this task",
    "/retry · Retry failed iMessage-started work",
    "/dismiss · Remove failed work from the queue",
    "",
    "**Settings**",
    "/defaultreasoning (level/none) · View or change default reasoning",
  ].join("\n"));
});

test("recent directory follows the canonical project, selected, row, and note grammar", () => {
  const rendered = renderThreadDirectory({
    totalTasks: 3,
    groups: [
      {
        projectKey: "handoff",
        projectLabel: "iMessage handoff",
        startedAt: "2026-07-01T00:00:00.000Z",
        threads: [
          {
            ...ACTIVE,
            index: 1,
            current: true,
            status: "working",
            stateSince: "2026-07-12T07:56:00.000Z",
            requestPreview: "Show a full example set of every message type.",
          },
          {
            id: "duplicate-history",
            index: 2,
            title: "Fix duplicate fork history",
            createdAt: "2026-07-12T06:30:00.000Z",
            projectKey: "handoff",
            projectLabel: "iMessage handoff",
            status: "working",
            stateSince: "2026-07-12T07:52:00.000Z",
            pendingCount: 2,
            requestPreview: "Prevent inherited history from replaying.",
          },
        ],
      },
      {
        projectKey: "other-tasks",
        projectLabel: "Other tasks",
        threads: [
          {
            id: "compare-providers",
            index: 3,
            title: "Compare messaging providers",
            createdAt: "2026-07-10T08:00:00.000Z",
            status: "idle",
            activityAt: "2026-07-12T05:00:00.000Z",
            turnCount: 50,
            requestPreview: "Which provider supports richer interactions?",
          },
        ],
      },
    ],
  }, { now: "2026-07-12T08:00:00.000Z", ...activeOptions });

  assert.equal(rendered, [
    "▾  ○ 📐 **iMessage handoff** · 2 tasks",
    "",
    "**Selected**",
    "1️⃣  ◷ 🪁 **Polish message formatting**",
    "   ◷ Working for 4m",
    "   “Show a full example set of every message type.”",
    "",
    "2️⃣  ◷ 🗺️ Fix duplicate fork history",
    "   ◷ Working for 8m · 2 queued",
    "   “Prevent inherited history from replaying.”",
    "",
    "▾ ○ **Other tasks** · 1 task",
    "",
    "3️⃣  ○ 🗺️ Compare messaging providers",
    "   ○ 3h ago · 50 turns",
    "   “Which provider supports richer interactions?”",
    "",
    "Reply with a number to open that thread. Add “1 (message)” to directly message the thread.",
    "“/projects” - See all projects",
    "“/search” - Show threads with specific text",
  ].join("\n"));
  assert.doesNotMatch(rendered.split("▾ ○ **Other tasks**")[0], /Other tasks/);
  assert.match(rendered, /▾ ○ \*\*Other tasks\*\* · 1 task/);
});

test("project menu is an exact minimal styled list", () => {
  const rendered = renderThreadMenu([
    {
      id: "handoff-project",
      index: 1,
      title: "iMessage handoff",
      createdAt: "2026-07-01T00:00:00.000Z",
      threadCount: 2,
      status: "working",
    },
    {
      id: "crawler-project",
      index: 2,
      title: "Music crawler",
      createdAt: "2026-06-01T00:00:00.000Z",
      threadCount: 5,
      status: "idle",
      activityAt: "2026-07-12T07:00:00.000Z",
    },
  ], { label: "PROJECTS", now: "2026-07-12T08:00:00.000Z" });

  assert.equal(rendered, [
    "**Projects**",
    "",
    "1️⃣  ◷ 📐 **iMessage handoff**",
    "   ◷ Working · 2 tasks",
    "",
    "2️⃣  ○ 🧪 **Music crawler**",
    "   ○ 1h ago · 5 tasks",
    "",
    "Reply with a number to show that project.",
    "“/threads” - See recent threads",
    "“/search” - Show threads with specific text",
  ].join("\n"));
});

test("thread and project identity seeds normalize name plus start date", () => {
  const thread = { title: "Polish message formatting", createdAt: "2026-07-12T07:00:00.000Z" };
  const normalizedThread = { title: " polish   message FORMATTING ", createdAt: "2026-07-12T07:00:00Z" };
  assert.equal(threadIdentityEmoji(thread), "🪁");
  assert.equal(threadIdentityEmoji(normalizedThread), "🪁");
  assert.equal(threadIdentityEmoji({ ...thread, title: "Renamed message formatting" }), "🔖");
  assert.equal(threadIdentityEmoji({ ...thread, createdAt: "2026-07-13T07:00:00Z" }), "🧩");

  const project = { projectLabel: "iMessage handoff", startedAt: "2026-07-01T00:00:00Z" };
  const normalizedProject = { projectLabel: " IMESSAGE   HANDOFF ", startedAt: "2026-07-01T00:00:00.000Z" };
  assert.equal(projectIdentityEmoji(project), "📐");
  assert.equal(projectIdentityEmoji(normalizedProject), "📐");
  assert.equal(projectIdentityEmoji({ ...project, projectLabel: "iMessage service" }), "🧭");
  assert.equal(projectIdentityEmoji({ ...project, startedAt: "2026-07-02T00:00:00Z" }), "🪁");
});

test("thread header is a separate message with status, reasoning, link, and commands", () => {
  const thread = {
    ...ACTIVE,
    status: "working",
    stateSince: "2026-07-12T07:56:00.000Z",
    pendingCount: 2,
    reasoningEffort: "high",
  };
  const expected = [
    "🪁 **Polish message formatting**",
    "",
    "◷ Working for 4m · 2 queued",
    "🔍 Reasoning: High",
    "",
    "codex://threads/active-thread",
    "",
    "👍 listen · 👎 mute · ❓ status + history",
    "/link · /cancel",
  ].join("\n");
  assert.equal(renderThreadHeader(thread, "2026-07-12T08:00:00.000Z"), expected);

  const stableThread = { ...thread, status: "error", activityAt: null, stateSince: null, pendingCount: 0 };
  const stableExpected = expected
    .replace("◷ Working for 4m · 2 queued", "▲ Needs attention");
  const event = { kind: "thread.header", thread: stableThread };
  assert.equal(renderOutboundEvent(event, activeOptions), stableExpected);
  assert.deepEqual(renderOutboundMessages(event, activeOptions), [stableExpected]);

  const mutedListening = { ...thread, muted: true, listening: true };
  assert.equal(renderThreadHeader(mutedListening, "2026-07-12T08:00:00.000Z"), expected
    .replace("🔍 Reasoning: High", "🔍 Reasoning: High\nUpdates: muted\nListening: next turn"));
});

test("thread detail is split into semantic messages without repeated framing", () => {
  const event = {
    kind: "thread.detail",
    thread: ACTIVE,
    state: "working",
    requestPreview: { body: "Redo the message structure." },
    assistantMessages: [
      { body: "I’m mapping every outbound event.", phase: "commentary" },
      { body: "The minimal formatter is ready.", phase: "final_answer" },
    ],
  };
  assert.deepEqual(renderOutboundMessages(event, activeOptions), [
    "👤 Redo the message structure.",
    "I’m mapping every outbound event.\n\nThe minimal formatter is ready.",
  ]);
  assert.equal(renderOutboundEvent(event, activeOptions), [
    "👤 Redo the message structure.",
    "I’m mapping every outbound event.\n\nThe minimal formatter is ready.",
  ].join("\n\n\n"));
});

test("live mirror uses one user marker and leaves assistant content raw", () => {
  assert.equal(renderOutboundEvent({
    kind: "thread.live-message",
    messageId: "user-1",
    thread: ACTIVE,
    role: "user",
    body: "Use this message structure.",
  }, activeOptions), "👤 Use this message structure.");

  assert.equal(renderOutboundEvent({
    kind: "thread.live-message",
    messageId: "assistant-1",
    thread: ACTIVE,
    role: "assistant",
    phase: "commentary",
    body: "I’m updating the formatter.",
  }, activeOptions), "I’m updating the formatter.");
});

test("active results are raw while background results identify their thread", () => {
  assert.equal(renderOutboundEvent({
    kind: "thread.output",
    thread: ACTIVE,
    body: "The formatting pass is complete.",
  }, activeOptions), "The formatting pass is complete.");

  assert.equal(renderOutboundEvent({
    kind: "thread.completed",
    completionId: "crawler-complete",
    thread: OTHER,
    body: "The crawler is repaired.",
  }, activeOptions), "🪴 **Repair the crawler**\n\nThe crawler is repaired.");
});

test("turn transcript uses triple-newline blocks and deduplicates the final response", () => {
  const rendered = renderOutboundEvent({
    kind: "thread.turn",
    thread: ACTIVE,
    turn: {
      request: "Review the new structure.",
      assistantMessages: [
        { body: "I found one remaining legacy wrapper.", phase: "commentary" },
        { body: "Removed it. All checks pass.", phase: "final_answer" },
      ],
      finalResponse: "Removed it. All checks pass.",
    },
  }, activeOptions);
  assert.equal(rendered, [
    "👤 Review the new structure.",
    "☁️ I found one remaining legacy wrapper.",
    "☁️ Removed it. All checks pass.",
  ].join("\n\n\n"));
  assert.equal(rendered.match(/Removed it\. All checks pass\./g)?.length, 1);
});

test("history is one minimal transcript with triple-newline role blocks", () => {
  const rendered = renderOutboundEvent({
    kind: "thread.history",
    thread: ACTIVE,
    turns: [
      { request: "First request.", finalResponse: "First result." },
      {
        request: "Second request.",
        assistantMessages: [{ body: "Second update." }, { body: "Second result." }],
        finalResponse: "Second result.",
      },
    ],
  }, activeOptions);
  assert.equal(rendered, [
    "👤 First request.",
    "☁️ First result.",
    "👤 Second request.",
    "☁️ Second update.",
    "☁️ Second result.",
  ].join("\n\n\n"));
});

test("detail and history disclose omitted content with actionable commands", () => {
  assert.deepEqual(renderOutboundMessages({
    kind: "thread.detail",
    thread: ACTIVE,
    state: "idle",
    requestPreview: { body: "A shortened request…", truncated: true },
    historyTruncated: true,
  }, activeOptions), [
    "👤 A shortened request…\n\nRequest shortened · /request shows it in full.",
    "Older task context wasn’t loaded · /turn or /history 5",
  ]);

  assert.equal(renderOutboundEvent({
    kind: "thread.history",
    thread: ACTIVE,
    turns: [{ request: "Newest request.", finalResponse: "Newest result." }],
    hasMore: true,
  }, activeOptions), [
    "👤 Newest request.",
    "☁️ Newest result.",
    "Earlier completed turns exist · /history 5 shows the newest five.",
  ].join("\n\n\n"));
});

test("a command response that loses the selection race identifies its source once", () => {
  assert.equal(renderOutboundEvent({
    kind: "thread.history",
    thread: OTHER,
    turns: [{ request: "Repair the crawler.", finalResponse: "Crawler repaired." }],
  }, activeOptions), [
    "🪴 **Repair the crawler**",
    "👤 Repair the crawler.",
    "☁️ Crawler repaired.",
  ].join("\n\n\n").replace("\n\n\n👤", "\n\n👤"));

  assert.deepEqual(renderOutboundMessages({
    kind: "thread.detail",
    thread: OTHER,
    state: "idle",
    requestPreview: { body: "Repair the crawler." },
    assistantMessages: [{ body: "Crawler repaired." }],
  }, activeOptions), [
    "🪴 **Repair the crawler**\n\n👤 Repair the crawler.",
    "Crawler repaired.",
  ]);
});

test("reasoning view, changed, removed, and invalid states are minimal and exact", () => {
  assert.equal(renderOutboundEvent({
    kind: "service.reasoning",
    thread: ACTIVE,
    current: "high",
    options: [
      { value: "default", selected: false },
      { value: "high", selected: true },
      { value: "xhigh", selected: false },
    ],
  }, activeOptions), "**Reasoning**\n○ ↩️ Inherit\n● 🔍 High · selected\n○ 🔬 Extra high\n\n/reasoning (level/none)");

  assert.equal(renderOutboundEvent({
    kind: "service.reasoning",
    thread: ACTIVE,
    current: "xhigh",
    options: [{ value: "xhigh", selected: true }],
    changed: true,
  }, activeOptions), "Reasoning set to 🔬 **Extra high**.");

  assert.equal(renderOutboundEvent({
    kind: "service.reasoning",
    thread: ACTIVE,
    current: "default",
    options: [{ value: "default", selected: true }],
    changed: true,
  }, activeOptions), "Reasoning override removed.");

  assert.equal(renderOutboundEvent({
    kind: "service.reasoning",
    thread: ACTIVE,
    options: [],
    invalid: "maximum",
  }, activeOptions), "“maximum” isn’t a reasoning level.\n\n/reasoning (level/none)");
});

test("presence and notices contain only their useful content", () => {
  assert.equal(
    renderOutboundEvent({ kind: "service.presence", state: "online" }, activeOptions),
    "● Codex is online.",
  );
  assert.equal(
    renderOutboundEvent({ kind: "service.presence", state: "offline" }, activeOptions),
    "○ Codex is offline. New messages will wait until it reconnects.",
  );
  assert.equal(renderOutboundEvent({
    kind: "service.notice",
    code: "updated",
    body: "Reasoning changed to high.",
    thread: ACTIVE,
  }, activeOptions), "Reasoning changed to high.");
  assert.equal(renderOutboundEvent({
    kind: "service.notice",
    code: "needs-attention",
    body: "Codex could not complete this request.",
    thread: OTHER,
  }, activeOptions), "🪴 **Repair the crawler**\n\nCodex could not complete this request.");
});

test("menu selection accepts bare, whitespace, parenthesized, and legacy colon prompts", () => {
  assert.deepEqual(parseMenuSelection("2"), { index: 1, prompt: null });
  assert.deepEqual(parseMenuSelection("2 run"), { index: 1, prompt: "run" });
  assert.deepEqual(parseMenuSelection("2 (run)"), { index: 1, prompt: "run" });
  assert.deepEqual(parseMenuSelection("2: run"), { index: 1, prompt: "run" });
  assert.equal(parseMenuSelection("run"), null);
  assert.equal(parseMenuSelection("0"), null);
});

test("multipart messages use only a compact part marker", () => {
  assert.equal(renderOutboundEvent({
    kind: "thread.output",
    thread: ACTIVE,
    body: "Continued result content.",
  }, { ...activeOptions, part: { index: 2, total: 3 } }), "(2/3)\n\nContinued result content.");
});

test("canonical outputs never reintroduce universal headers, rules, context, or footers", () => {
  const outputs = [
    renderHelp(),
    renderOutboundEvent({ kind: "thread.output", thread: ACTIVE, body: "Done." }, activeOptions),
    renderOutboundEvent({ kind: "thread.live-message", messageId: "u", thread: ACTIVE, role: "user", body: "Go." }, activeOptions),
    renderOutboundEvent({ kind: "thread.progress", thread: ACTIVE, phase: "Running tests." }, activeOptions),
    renderOutboundEvent({ kind: "thread.header", thread: { ...ACTIVE, status: "error" } }, activeOptions),
    renderOutboundEvent({ kind: "service.presence", state: "online" }, activeOptions),
    renderOutboundEvent({ kind: "service.notice", code: "connected", body: "Connected." }, activeOptions),
  ];
  for (const output of outputs) {
    assert.doesNotMatch(output, /(?:^|\n)CODEX\b/);
    assert.doesNotMatch(output, /Active context|Now active|⌁|[━─]{3,}|footer/i);
  }
});
