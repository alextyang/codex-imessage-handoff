#!/usr/bin/env node
import WebSocket from "ws";
import os from "node:os";
import { readConfig } from "./config.mjs";
import { listThreads, findThread } from "./thread-store.mjs";
import { RelayClient } from "./relay-client.mjs";
import { CodexRunner } from "./codex-runner.mjs";

const config = readConfig();
const relay = new RelayClient(config);
const runner = new CodexRunner();
let queue = Promise.resolve();
let stopped = false;
let lastProgressAt = 0;
let progressTimer = null;
let pendingPhase = null;

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function synchronize() {
  const threads = await listThreads(100);
  await relay.syncCatalog(threads.map((thread) => ({ ...thread, cwd: thread.projectLabel || "Codex" })));
  return threads;
}

async function publishFailure(thread, error) {
  const body = error?.code === "BUSY"
    ? "This thread is already running in Codex. Your message remains queued."
    : error?.code === "MISSING_CWD"
      ? "This thread’s project folder is no longer available.\nText /threads to choose another."
      : "Codex could not complete this request. Try again or continue locally in Codex.";
  await relay.outbound({ kind: "service.notice", code: error?.code === "BUSY" ? "queued" : "needs-attention", thread, body });
}

async function handleReply(event) {
  const thread = await findThread(String(event.threadId || ""));
  if (!thread) return;
  let claim;
  try {
    claim = await relay.claim(thread.id, String(event.replyId || ""));
  } catch (error) {
    if (error.status !== 409) log("Could not claim pending reply.");
    return;
  }
  const reply = claim.reply || {};
  const images = await relay.downloadImages(thread.id, reply);
  lastProgressAt = Date.now();
  pendingPhase = null;
  progressTimer = setInterval(async () => {
    if (!pendingPhase || Date.now() - lastProgressAt < 120000) return;
    const phase = pendingPhase;
    pendingPhase = null;
    lastProgressAt = Date.now();
    try {
      await relay.outbound({ kind: "thread.progress", thread, phase });
    } catch {
      log("Could not publish progress.");
    }
  }, 10000);
  progressTimer.unref();
  try {
    await relay.updateThreadStatus(thread, "working");
    const result = await runner.run({
      thread,
      prompt: String(reply.body || ""),
      images,
      onPhase: (phase) => {
        if (Date.now() - lastProgressAt >= 60000) pendingPhase = phase;
      },
    });
    if (result.status === "cancelled") {
      await relay.outbound({ kind: "service.notice", code: "cancelled", thread, body: "Stopped at your request." });
      await relay.updateThreadStatus(thread, "idle");
    } else {
      await relay.outbound({ kind: "thread.output", thread, body: result.body });
      if (Array.isArray(result.generatedImages) && result.generatedImages.length > 0) {
        await relay.publishImages(thread, result.generatedImages);
      } else {
        await relay.updateThreadStatus(thread, "idle");
      }
    }
  } catch (error) {
    await publishFailure(thread, error);
    try { await relay.updateThreadStatus(thread, error?.code === "BUSY" ? "queued" : "error"); } catch {}
  } finally {
    clearInterval(progressTimer);
    progressTimer = null;
    pendingPhase = null;
  }
}

async function handleControl(event) {
  if (event.command !== "cancel") return;
  const thread = event.threadId ? await findThread(String(event.threadId)) : null;
  const cancelled = runner.cancel(event.threadId ? String(event.threadId) : undefined);
  if (!cancelled) {
    await relay.outbound({ kind: "service.notice", code: "needs-attention", thread: thread || undefined, body: "There is no active Codex run to cancel." });
  }
}

function connect() {
  if (stopped) return;
  const socket = new WebSocket(relay.eventsUrl());
  socket.on("open", () => {
    log("Connected to relay.");
    socket.send(JSON.stringify({ type: "service-connected", clientId: config.clientId }));
  });
  socket.on("message", (data) => {
    try {
      const event = JSON.parse(String(data));
      if (event.type === "reply-pending") queue = queue.then(() => handleReply(event)).catch(() => log("Queued reply failed."));
      if (event.type === "control") queue = queue.then(() => handleControl(event)).catch(() => log("Control command failed."));
    } catch {
      log("Ignored malformed relay event.");
    }
  });
  socket.on("close", () => {
    if (!stopped) setTimeout(connect, 2000 + Math.floor(Math.random() * 2000)).unref();
  });
  socket.on("error", () => socket.close());
}

async function main() {
  const registration = await relay.register();
  const threads = await synchronize();
  if (registration.pairingRequired) {
    log(`Pairing required: text ${registration.pairingCode} to ${registration.sendblueNumber} within 15 minutes.`);
  } else {
    log(`Ready on ${os.hostname()} with ${threads.length} threads.`);
  }
  connect();
  setInterval(async () => {
    try {
      await relay.register();
      await synchronize();
    } catch {
      log("Background synchronization failed; will retry.");
    }
  }, 5 * 60 * 1000).unref();
}

process.on("SIGTERM", () => { stopped = true; runner.cancel(); process.exit(0); });
process.on("SIGINT", () => { stopped = true; runner.cancel(); process.exit(0); });

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
