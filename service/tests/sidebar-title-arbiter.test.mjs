import assert from "node:assert/strict";
import test from "node:test";
import { SidebarTitleArbiter } from "../src/sidebar-title-arbiter.mjs";

test("live sidebar notifications cannot be rolled back by a stale index snapshot", () => {
  let now = 10_000;
  const arbiter = new SidebarTitleArbiter({ now: () => now, ttlMs: 60_000 });
  assert.equal(arbiter.resolve("thread-a", { title: "Old", updatedAt: 9_000 }), "Old");
  assert.equal(arbiter.resolve("thread-a", "Live rename", { source: "notification" }), "Live rename");
  assert.equal(
    arbiter.resolve("thread-a", { title: "Old", updatedAt: 9_000 }, { source: "index" }),
    "Live rename",
  );
  assert.equal(
    arbiter.resolve("thread-a", { title: "Live rename", updatedAt: 9_500 }, { source: "index" }),
    "Live rename",
  );

  now = 11_000;
  assert.equal(arbiter.resolve("thread-a", "Newest live", { source: "notification" }), "Newest live");
  assert.equal(
    arbiter.resolve("thread-a", { title: "Newer disk rename", updatedAt: 12_000 }, { source: "index" }),
    "Newer disk rename",
  );
});

test("an unpersisted live title expires rather than masking the index forever", () => {
  let now = 20_000;
  const arbiter = new SidebarTitleArbiter({ now: () => now, ttlMs: 1_000 });
  assert.equal(arbiter.resolve("thread-a", "Live rename", { source: "notification" }), "Live rename");
  now = 21_001;
  assert.equal(
    arbiter.resolve("thread-a", { title: "Persisted fallback", updatedAt: 19_000 }, { source: "index" }),
    "Persisted fallback",
  );
});
