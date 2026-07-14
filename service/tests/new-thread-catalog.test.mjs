import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreatedThread } from "../src/new-thread-catalog.mjs";

test("a new task never promotes its first request or database preview into its title", () => {
  const created = normalizeCreatedThread({
    id: "thread-new",
    title: "Build the entire private first request verbatim",
    createdAt: 1_783_987_200,
  }, {
    cwd: "/tmp/project",
    projectKey: "project-a",
    projectLabel: "Project A",
    threadSource: "imessage-handoff:new:flow-a",
  }, "Another first-message preview");

  assert.equal(created.title, "Untitled task");
  assert.equal(created.sidebarTitle, null);
  assert.doesNotMatch(JSON.stringify({ title: created.title }), /private|preview/i);
});
