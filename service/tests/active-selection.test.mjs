import assert from "node:assert/strict";
import test from "node:test";
import { ActiveSelection } from "../src/active-selection.mjs";

test("a newer explicit selection invalidates an in-flight compare-and-swap", () => {
  const selection = new ActiveSelection();
  selection.update("parent", "2026-07-12T20:00:00.000Z");
  const pendingFollow = selection.capture();
  selection.update("manual", "2026-07-12T20:00:01.000Z");
  assert.equal(selection.isCurrent(pendingFollow), false);
  assert.equal(selection.id, "manual");
});

test("repeated stale registration does not invalidate work but user activity does", () => {
  const selection = new ActiveSelection();
  selection.update("parent", "2026-07-12T20:00:00.000Z");
  const pendingFollow = selection.capture();
  selection.update("parent", "2026-07-12T20:00:00.000Z");
  selection.update("parent", "2026-07-12T19:59:00.000Z");
  assert.equal(selection.isCurrent(pendingFollow), true);
  selection.update("parent", "2026-07-12T20:00:02.000Z");
  assert.equal(selection.isCurrent(pendingFollow), false);
});

test("clearing a selection invalidates a pending follow", () => {
  const selection = new ActiveSelection();
  selection.update("parent", "2026-07-12T20:00:00.000Z");
  const pendingFollow = selection.capture();
  selection.update(null, null);
  assert.equal(selection.isCurrent(pendingFollow), false);
  assert.equal(selection.selectedAt, null);
});
