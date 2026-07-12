import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function safePhase(event) {
  const type = String(event?.type || "");
  const itemType = String(event?.item?.type || event?.item_type || "");
  if (type.includes("turn.started")) return "Starting work.";
  if (itemType.includes("command") && type.includes("started")) return "Running project tools.";
  if ((itemType.includes("mcp") || itemType.includes("tool")) && type.includes("started")) return "Using a connected tool.";
  if (type.includes("turn.completed")) return "Finishing the response.";
  return null;
}

function generatedImagePath(event) {
  const item = event?.item && typeof event.item === "object" ? event.item : null;
  const type = String(item?.type || event?.type || "").toLowerCase();
  if (!type.includes("image")) return null;
  for (const value of [item?.path, item?.image_path, item?.output_path, event?.path, event?.image_path]) {
    if (typeof value === "string" && /\.(png|jpe?g|webp|gif)$/i.test(value) && existsSync(value)) return value;
  }
  return null;
}

export class CodexRunner {
  constructor(options = {}) {
    this.codexPath = options.codexPath || process.env.CODEX_BIN || "codex";
    this.active = null;
  }

  isRunning() {
    return Boolean(this.active);
  }

  cancel(threadId) {
    if (!this.active || (threadId && this.active.threadId !== threadId)) return false;
    this.active.cancelled = true;
    this.active.child.kill("SIGTERM");
    const child = this.active.child;
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000).unref();
    return true;
  }

  async run({ thread, prompt, images = [], reasoningEffort, onPhase = () => {} }) {
    if (this.active) throw Object.assign(new Error("Another Codex run is active."), { code: "BUSY" });
    if (!existsSync(thread.cwd)) throw Object.assign(new Error("Thread working directory no longer exists."), { code: "MISSING_CWD" });
    const temporary = path.join(os.tmpdir(), `imessage-handoff-${process.pid}-${Date.now()}`);
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const outputFile = path.join(temporary, "last-message.txt");
    const args = ["exec"];
    if (typeof reasoningEffort === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(reasoningEffort)) {
      args.push("--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    }
    args.push("resume", "--skip-git-repo-check", "--json", "--output-last-message", outputFile);
    for (const image of images) args.push("--image", image);
    args.push(thread.id, "-");
    const child = spawn(this.codexPath, args, {
      cwd: thread.cwd,
      env: { ...process.env, CODEX_THREAD_ID: thread.id },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const active = { child, threadId: thread.id, cancelled: false };
    this.active = active;
    let stderr = "";
    let lastPhase = null;
    const generatedImages = new Set();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        const phase = safePhase(event);
        const imagePath = generatedImagePath(event);
        if (imagePath) generatedImages.add(imagePath);
        if (phase && phase !== lastPhase) {
          lastPhase = phase;
          onPhase(phase);
        }
      } catch {
        // Ignore non-JSON diagnostic lines; never forward raw output.
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(String(prompt));
    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } catch (error) {
      lines.close();
      this.active = null;
      rmSync(temporary, { recursive: true, force: true });
      throw Object.assign(new Error("Codex could not be started.", { cause: error }), { code: "CODEX_UNAVAILABLE" });
    }
    lines.close();
    this.active = null;
    const cancelled = active.cancelled;
    const body = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";
    rmSync(temporary, { recursive: true, force: true });
    if (cancelled) return { status: "cancelled", body: "" };
    if (exit.code !== 0) {
      const busy = /already.*(running|locked)|session.*lock|thread.*busy/i.test(stderr);
      const code = busy
        ? "BUSY"
        : /not inside a trusted directory|skip-git-repo-check/i.test(stderr)
          ? "GIT_CHECK_FAILED"
          : /not logged in|authentication|unauthorized|status\s*401/i.test(stderr)
            ? "AUTH_REQUIRED"
            : "CODEX_FAILED";
      throw Object.assign(new Error(busy ? "Thread is busy." : "Codex could not complete the request."), { code });
    }
    return { status: "completed", body: body || "Codex completed without a text response.", generatedImages: [...generatedImages] };
  }
}
