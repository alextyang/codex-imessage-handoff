import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PendingFollowStore } from "../src/pending-follow-store.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-follow-state-"));
  const file = path.join(directory, "pending-follow.json");
  return { file, store: new PendingFollowStore(file) };
}

test("pending fork context survives restart privately until its exact delivery clears", () => {
  const item = fixture();
  item.store.save({ deliveryId: "delivery-a", threadId: "child", parentThreadId: "parent", event: null });
  assert.equal(statSync(item.file).mode & 0o777, 0o600);
  const restarted = new PendingFollowStore(item.file);
  const pending = restarted.get();
  pending.event = { kind: "thread.detail", deliveryId: "delivery-a", reason: "fork", thread: { id: "child" } };
  restarted.save(pending);
  assert.equal(restarted.clear("other"), false);
  assert.equal(restarted.get().event.thread.id, "child");
  assert.equal(restarted.clear("delivery-a"), true);
  assert.equal(restarted.get(), null);
});

test("corrupt pending context is quarantined without exposing it", () => {
  const item = fixture();
  writeFileSync(item.file, "not-json", { mode: 0o644 });
  assert.equal(item.store.get(), null);
  const quarantined = readdirSync(path.dirname(item.file)).find((name) => name.startsWith("pending-follow.json.invalid-"));
  assert.equal(readFileSync(path.join(path.dirname(item.file), quarantined), "utf8"), "not-json");
});
