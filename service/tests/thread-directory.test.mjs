import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadDirectory, directoryConstants, requestPreview } from "../src/thread-directory.mjs";

const NOW = Date.parse("2026-07-12T12:00:00.000Z");

function at(milliseconds) {
  return new Date(NOW + milliseconds).toISOString();
}

function thread(id, projectKey, projectLabel, lastTurnOffset, extras = {}) {
  const lastTurnAt = lastTurnOffset === null ? null : at(lastTurnOffset);
  return {
    id,
    title: extras.title || id,
    projectKey,
    projectLabel,
    groupKind: extras.groupKind || (projectKey ? "project" : "other"),
    lastTurnAt,
    lastTurnAtMs: lastTurnAt ? Date.parse(lastTurnAt) : null,
  };
}

test("directory includes all pending and 48-hour tasks, orders pending first, and puts Other tasks last", async () => {
  const states = new Map([
    ["old-pending", { status: "pending", stateSince: at(-60_000), pendingCount: 1, latestRequest: "Old but queued", latestRequestAt: at(-60_000) }],
    ["recent-pending", { status: "pending", stateSince: at(-120_000), pendingCount: 1, latestRequest: "Queued and recent", latestRequestAt: at(-120_000) }],
    ["working-queued", { status: "working", stateSince: at(-180_000), pendingCount: 2, latestRequest: "Newest\nqueued request", latestRequestAt: at(-30_000) }],
  ]);
  const threads = [
    thread("recent-idle", "alpha", "Alpha", -60 * 60_000),
    thread("old-idle", "alpha", "Alpha", -49 * 60 * 60_000),
    thread("old-pending", "alpha", "Alpha", -7 * 24 * 60 * 60_000),
    thread("recent-pending", "alpha", "Alpha", -30 * 60_000),
    thread("working-queued", "alpha", "Alpha", -7 * 24 * 60 * 60_000),
    thread("empty-project", "empty", "Empty project", -49 * 60 * 60_000),
    thread("other-recent", null, null, -2 * 60 * 60_000, { groupKind: "other" }),
    thread("other-old", null, null, -50 * 60 * 60_000, { groupKind: "other" }),
    thread("cutoff", "boundary", "Boundary", -directoryConstants.recentWindowMs),
    thread("outside", "boundary", "Boundary", -directoryConstants.recentWindowMs - 1),
    thread("recent-idle", "alpha", "Alpha", -60 * 60_000),
  ];
  const planned = await buildThreadDirectory(threads, {
    now: NOW,
    activeThreadId: "recent-idle",
    stateFor: (item) => states.get(item.id) || { status: "idle", stateSince: item.lastTurnAt, pendingCount: 0, latestRequest: null },
    latestRequest: async (item) => `Latest user request for ${item.id}`,
  });

  assert.deepEqual(planned.directory.groups.map((group) => group.projectLabel), ["Alpha", "Boundary", "Other tasks"]);
  assert.deepEqual(planned.directory.groups[0].threads.map((item) => item.id), [
    "working-queued",
    "old-pending",
    "recent-pending",
    "recent-idle",
  ]);
  assert.equal(planned.directory.groups[0].threads[0].pendingCount, 2);
  assert.equal(planned.directory.groups[0].threads[0].requestPreview, "Newest queued request");
  assert.equal(planned.directory.groups[0].threads[3].current, true);
  assert.deepEqual(planned.directory.groups[1].threads.map((item) => item.id), ["cutoff"]);
  assert.deepEqual(planned.directory.groups[2].threads.map((item) => item.id), ["other-recent"]);
  assert.equal(planned.directory.totalTasks, 6);
  assert.deepEqual(planned.references, [
    "thread:working-queued",
    "thread:old-pending",
    "thread:recent-pending",
    "thread:recent-idle",
    "thread:cutoff",
    "thread:other-recent",
  ]);
  assert.deepEqual(planned.directory.groups.flatMap((group) => group.threads.map((item) => item.index)), [1, 2, 3, 4, 5, 6]);
  assert.equal(planned.references.some((reference) => reference.includes("old-idle") || reference.includes("outside")), false);
});

test("request previews are single-line, bounded, and always present", async () => {
  assert.equal(requestPreview("  first\n\nsecond  "), "first second");
  assert.equal(requestPreview(""), "No text in the latest request.");
  const long = requestPreview("x".repeat(300));
  assert.equal(long.length, directoryConstants.requestPreviewLength);
  assert.match(long, /…$/);

  const planned = await buildThreadDirectory([
    thread("no-text", "alpha", "Alpha", -1),
  ], {
    now: NOW,
    stateFor: () => ({ status: "idle", pendingCount: 0, latestRequest: null }),
    latestRequest: async () => "",
  });
  assert.equal(planned.directory.groups[0].threads[0].requestPreview, "No text in the latest request.");
});

test("preview compares local rollout and queued timestamps without changing FIFO state", async () => {
  const planned = await buildThreadDirectory([
    thread("newer-local", "alpha", "Alpha", -60_000),
    thread("newer-queued", "alpha", "Alpha", -120_000),
  ], {
    now: NOW,
    stateFor: (item) => item.id === "newer-local"
      ? { status: "error", pendingCount: 0, latestRequest: "Older failed request", latestRequestAt: at(-120_000) }
      : { status: "pending", pendingCount: 1, latestRequest: "New queued request", latestRequestAt: at(-30_000) },
    latestRequest: async (item) => item.id === "newer-local"
      ? { body: "Newest local request", at: at(-60_000) }
      : { body: "Older rollout request", at: at(-120_000) },
  });
  const rows = planned.directory.groups[0].threads;
  assert.equal(rows.find((item) => item.id === "newer-local").requestPreview, "Newest local request");
  assert.equal(rows.find((item) => item.id === "newer-queued").requestPreview, "New queued request");
});

test("directory keeps every qualifying row beyond the old eight-task budget", async () => {
  const threads = Array.from({ length: 12 }, (_, index) => thread(`recent-${index}`, "alpha", "Alpha", -(index + 1) * 60_000));
  const planned = await buildThreadDirectory(threads, {
    now: NOW,
    stateFor: () => ({ status: "idle", pendingCount: 0, latestRequest: null }),
    latestRequest: async (item) => ({ body: `Request ${item.id}`, at: item.lastTurnAt }),
  });
  assert.equal(planned.directory.totalTasks, 12);
  assert.equal(planned.directory.groups[0].threads.length, 12);
  assert.deepEqual(planned.directory.groups[0].threads.map((item) => item.index), Array.from({ length: 12 }, (_, index) => index + 1));
});
