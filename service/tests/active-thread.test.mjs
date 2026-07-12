import assert from "node:assert/strict";
import test from "node:test";
import { activeDescendant } from "../src/active-thread.mjs";

const selectedAt = "2026-07-12T20:00:00.000Z";

function row(id, values = {}) {
  return { id, state: "idle", activityAt: "2026-07-12T19:00:00.000Z", ...values };
}

test("follows the newest running descendant after the current selection", () => {
  const threads = [
    row("parent", { state: "aborted" }),
    row("older-child", { forkedFromId: "parent", state: "running", activityAt: "2026-07-12T19:59:59.000Z" }),
    row("child", { forkedFromId: "parent", state: "running", activityAt: "2026-07-12T20:01:00.000Z" }),
    row("grandchild", { forkedFromId: "child", state: "running", activityAt: "2026-07-12T20:02:00.000Z" }),
  ];
  assert.equal(activeDescendant(threads, "parent", selectedAt)?.id, "grandchild");
});

test("does not override a running selection or jump to a sibling lineage", () => {
  const threads = [
    row("parent", { state: "running", activityAt: "2026-07-12T20:01:00.000Z" }),
    row("child", { forkedFromId: "parent", state: "running", activityAt: "2026-07-12T20:02:00.000Z" }),
    row("sibling", { forkedFromId: "other", state: "running", activityAt: "2026-07-12T20:03:00.000Z" }),
  ];
  assert.equal(activeDescendant(threads, "parent", selectedAt), null);

  threads[0].state = "idle";
  threads[1].activityAt = "2026-07-12T19:59:00.000Z";
  assert.equal(activeDescendant(threads, "parent", selectedAt), null);
});

test("follows a grandchild through a hidden parent without jumping to a sibling", () => {
  const threads = [
    row("root"),
    row("selected", { forkedFromId: "root", lineageAncestorIds: ["root"] }),
    // `hidden-parent` is archived/filtered and intentionally absent.
    row("grandchild", {
      forkedFromId: "hidden-parent",
      lineageAncestorIds: ["hidden-parent", "selected", "root"],
      state: "running",
      activityAt: "2026-07-12T20:02:00.000Z",
    }),
    row("sibling", {
      forkedFromId: "root",
      lineageAncestorIds: ["root"],
      state: "running",
      activityAt: "2026-07-12T20:03:00.000Z",
    }),
  ];

  assert.equal(activeDescendant(threads, "selected", selectedAt)?.id, "grandchild");
  threads.find((thread) => thread.id === "grandchild").state = "idle";
  assert.equal(activeDescendant(threads, "selected", selectedAt), null,
    "a newer running sibling must not be mistaken for a descendant");
});

test("follows a running fork when its selected parent has been archived out of the catalog", () => {
  const threads = [
    row("archived-parent-child", {
      forkedFromId: "archived-parent",
      lineageAncestorIds: ["archived-parent"],
      state: "running",
      activityAt: "2026-07-12T20:05:00.000Z",
    }),
    row("unrelated", {
      lineageAncestorIds: ["other-root"],
      state: "running",
      activityAt: "2026-07-12T20:06:00.000Z",
    }),
  ];
  assert.equal(activeDescendant(threads, "archived-parent", selectedAt)?.id, "archived-parent-child");
});
