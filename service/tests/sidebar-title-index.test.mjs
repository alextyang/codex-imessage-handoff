import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import {
  clearSidebarTitleIndexCache,
  normalizeSidebarTitle,
  readSidebarTitleIndex,
  readSidebarTitleRecords,
  sidebarTitleIndexInternals,
} from "../src/sidebar-title-index.mjs";

test("sidebar title index uses the latest canonical Codex name and ignores malformed records", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-sidebar-titles-"));
  const file = path.join(directory, "session_index.jsonl");
  const records = [
    JSON.stringify({ id: "thread-a", thread_name: "First request preview" }),
    "{malformed",
    "x".repeat(sidebarTitleIndexInternals.maxIndexLineBytes + 1),
    JSON.stringify({ id: "thread-a", thread_name: "Sidebar title" }),
    JSON.stringify({ id: "thread-b", thread_name: "  Music\n  crawler  " }),
    JSON.stringify({ id: "thread-c", thread_name: "" }),
    JSON.stringify({ id: "invalid/id", thread_name: "Invalid identity" }),
  ];
  writeFileSync(file, `${records.join("\n")}\n${JSON.stringify({ id: "thread-d", thread_name: "No trailing newline" })}`);

  clearSidebarTitleIndexCache();
  const titles = await readSidebarTitleIndex(file);
  assert.equal(titles.get("thread-a"), "Sidebar title");
  assert.equal(titles.get("thread-b"), "Music crawler");
  assert.equal(titles.get("thread-d"), "No trailing newline");
  assert.equal(titles.has("thread-c"), false);
  assert.equal(titles.has("invalid/id"), false);

  appendFileSync(file, `\n${JSON.stringify({ id: "thread-a", thread_name: "Renamed in Codex" })}\n`);
  assert.equal((await readSidebarTitleIndex(file)).get("thread-a"), "Renamed in Codex");
  rmSync(file);
  assert.equal((await readSidebarTitleIndex(file)).get("thread-a"), "Renamed in Codex");

  const neverExisted = path.join(directory, "missing.jsonl");
  assert.equal((await readSidebarTitleIndex(neverExisted)).size, 0);
});

test("sidebar title index retains its last good snapshot after a transient read failure", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-sidebar-title-failure-"));
  const file = path.join(directory, "session_index.jsonl");
  writeFileSync(file, `${JSON.stringify({ id: "thread-a", thread_name: "Canonical name" })}\n`);
  clearSidebarTitleIndexCache();
  assert.equal((await readSidebarTitleIndex(file)).get("thread-a"), "Canonical name");

  const failed = await readSidebarTitleIndex(file, {
    bypassCache: true,
    createReadStreamImpl: () => { throw new Error("temporary read failure"); },
  });
  assert.equal(failed.get("thread-a"), "Canonical name");
});

test("sidebar title index rejects same-inode truncation and partial streams without dropping canonical names", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-sidebar-title-rewrite-"));
  const file = path.join(directory, "session_index.jsonl");
  writeFileSync(file, [
    JSON.stringify({ id: "thread-a", thread_name: "Task A", updated_at: "2026-07-14T12:00:00.000Z" }),
    JSON.stringify({ id: "thread-b", thread_name: "Task B", updated_at: "2026-07-14T12:00:01.000Z" }),
  ].join("\n") + "\n");
  clearSidebarTitleIndexCache();
  assert.equal((await readSidebarTitleIndex(file)).get("thread-b"), "Task B");

  writeFileSync(file, `${JSON.stringify({ id: "thread-a", thread_name: "Incomplete rewrite" })}\n`);
  const truncated = await readSidebarTitleIndex(file);
  assert.equal(truncated.get("thread-a"), "Task A");
  assert.equal(truncated.get("thread-b"), "Task B");

  const replacement = path.join(directory, "replacement.jsonl");
  writeFileSync(replacement, `${JSON.stringify({
    id: "thread-c",
    thread_name: "Atomic replacement",
    updated_at: "2026-07-14T12:00:02.000Z",
  })}\n`);
  renameSync(replacement, file);
  const replaced = await readSidebarTitleIndex(file);
  assert.equal(replaced.has("thread-b"), false);
  assert.equal(replaced.get("thread-c"), "Atomic replacement");

  appendFileSync(file, JSON.stringify({ id: "thread-d", thread_name: "Later task" }));
  const raw = Buffer.from(`${JSON.stringify({ id: "thread-c", thread_name: "Atomic replacement" })}\n`);
  const partial = await readSidebarTitleIndex(file, {
    bypassCache: true,
    createReadStreamImpl: () => Readable.from([raw.subarray(0, Math.floor(raw.length / 2))]),
  });
  assert.equal(partial.get("thread-c"), "Atomic replacement");
  assert.equal(partial.has("thread-d"), false);
});

test("sidebar title records expose the latest persisted timestamp for ordering", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-sidebar-title-record-"));
  const file = path.join(directory, "session_index.jsonl");
  writeFileSync(file, [
    JSON.stringify({ id: "thread-a", thread_name: "Old", updated_at: "2026-07-14T12:00:00.000Z" }),
    JSON.stringify({ id: "thread-a", thread_name: "New", updated_at: "2026-07-14T12:00:01.500Z" }),
  ].join("\n") + "\n");
  clearSidebarTitleIndexCache();
  assert.deepEqual((await readSidebarTitleRecords(file)).get("thread-a"), {
    title: "New",
    updatedAt: Date.parse("2026-07-14T12:00:01.500Z"),
  });
});

test("sidebar title normalization is bounded and strips control formatting", () => {
  assert.equal(normalizeSidebarTitle("  Alpha\t\nBeta  "), "Alpha Beta");
  assert.equal([...normalizeSidebarTitle("🧭".repeat(200))].length, 160);
  assert.equal(normalizeSidebarTitle(null), null);
});
