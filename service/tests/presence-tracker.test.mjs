import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PresenceTracker } from "../src/presence-tracker.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-presence-"));
  const file = path.join(directory, "presence.json");
  let sequence = 0;
  const create = () => new PresenceTracker(file, {
    now: () => Date.parse("2026-07-13T12:00:00.000Z") + sequence * 1000,
    randomUUID: () => `transition-${++sequence}`,
  });
  return { file, create };
}

test("initial readiness and same-state restarts do not emit startup boilerplate", async () => {
  const { create } = fixture();
  const delivered = [];
  const deliver = async (event) => { delivered.push(event); return { terminal: true, sent: true }; };
  assert.equal((await create().observe("online", { active: true, deliver })).baseline, true);
  assert.equal((await create().observe("online", { active: true, deliver })).changed, false);
  assert.deepEqual(delivered, []);
});

test("an offline startup baseline does not produce an unmatched online notice", async () => {
  const { create } = fixture();
  const delivered = [];
  assert.equal((await create().observe("offline", { active: true })).baseline, true);
  const recovered = await create().observe("online", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: true, sent: true }; },
  });
  assert.equal(recovered.collapsed, true);
  assert.deepEqual(delivered, []);
});

test("real offline and recovery edges emit once and survive restarts without duplicates", async () => {
  const { create } = fixture();
  const delivered = [];
  const deliver = async (event) => { delivered.push(event); return { terminal: true, sent: true }; };
  await create().observe("online", { active: true, deliver });
  const offline = await create().observe("offline", { active: true, deliver });
  assert.equal(offline.sent, true);
  assert.equal((await create().observe("offline", { active: true, deliver })).changed, false);
  const online = await create().observe("online", { active: true, deliver });
  assert.equal(online.sent, true);
  assert.deepEqual(delivered.map((event) => event.state), ["offline", "online"]);
  assert.equal(new Set(delivered.map((event) => event.deliveryId)).size, 2);
});

test("inactive edges and their unmatched recovery are settled without stale notifications", async () => {
  const { create } = fixture();
  const delivered = [];
  await create().observe("online", { active: false });
  const suppressed = await create().observe("offline", { active: false });
  assert.equal(suppressed.suppressed, true);
  assert.equal((await create().observe("offline", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: true, sent: true }; },
  })).changed, false);
  assert.deepEqual(delivered, []);

  const recovered = await create().observe("online", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: true, sent: true }; },
  });
  assert.equal(recovered.collapsed, true);
  assert.equal(recovered.suppressed, true);
  assert.deepEqual(delivered, []);
});

test("an undelivered offline-to-online flap collapses durably without an unsolicited recovery", async () => {
  const { create } = fixture();
  const delivered = [];
  await create().observe("online", { active: true });

  const offline = await create().observe("offline", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: false, sent: false }; },
  });
  assert.equal(offline.pending, true);

  const recovered = await create().observe("online", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: true, sent: true }; },
  });
  assert.equal(recovered.collapsed, true);
  assert.equal(recovered.sent, false);
  assert.deepEqual(delivered.map((event) => event.state), ["offline"]);

  const afterRestart = await create().observe("online", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: true, sent: true }; },
  });
  assert.equal(afterRestart.changed, false);
  assert.deepEqual(delivered.map((event) => event.state), ["offline"]);
});

test("a rejected offline delivery is still collapsed when health immediately recovers", async () => {
  const { create } = fixture();
  const delivered = [];
  await create().observe("online", { active: true });
  await assert.rejects(create().observe("offline", {
    active: true,
    deliver: async () => { throw new Error("transport unavailable"); },
  }), /transport unavailable/);

  const recovered = await create().observe("online", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: true, sent: true }; },
  });
  assert.equal(recovered.collapsed, true);
  assert.deepEqual(delivered, []);
});

test("a new process collapses a pending offline record left by an older deployment", async () => {
  const { file, create } = fixture();
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    observedState: "offline",
    transitionId: "legacy-offline-edge",
    transitionAt: "2026-07-13T11:59:00.000Z",
    settledTransitionId: null,
    delivery: "pending",
  })}\n`, { mode: 0o600 });
  const delivered = [];

  const recovered = await create().observe("online", {
    active: true,
    deliver: async (event) => { delivered.push(event); return { terminal: true, sent: true }; },
  });
  assert.equal(recovered.collapsed, true);
  assert.equal(recovered.suppressed, true);
  assert.deepEqual(delivered, []);
});

test("online delivery retries stably after a confirmed offline notification", async () => {
  const { create } = fixture();
  const delivered = [];
  const success = async (event) => { delivered.push(event); return { terminal: true, sent: true }; };
  await create().observe("online", { active: true });
  assert.equal((await create().observe("offline", { active: true, deliver: success })).sent, true);

  const failedIds = [];
  const pending = await create().observe("online", {
    active: true,
    deliver: async (event) => { failedIds.push(event.deliveryId); return { terminal: false, sent: false }; },
  });
  assert.equal(pending.pending, true);
  const retried = await create().observe("online", {
    active: true,
    deliver: async (event) => { failedIds.push(event.deliveryId); return { terminal: true, sent: true }; },
  });
  assert.equal(retried.sent, true);
  assert.deepEqual(failedIds, [failedIds[0], failedIds[0]]);
});
