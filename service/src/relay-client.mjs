import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { servicePaths } from "./paths.mjs";

export class RelayClient {
  constructor(config) {
    this.apiBaseUrl = config.apiBaseUrl;
    this.token = config.token;
    this.clientId = config.clientId;
  }

  async request(route, options = {}) {
    const response = await fetch(`${this.apiBaseUrl}${route}`, {
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw Object.assign(new Error(body.error || `Relay returned HTTP ${response.status}.`), { status: response.status });
    return body;
  }

  register() {
    return this.request("/service/register", {
      method: "POST",
      body: JSON.stringify({
        clientId: this.clientId,
        serviceVersion: "0.3.4",
        capabilities: [
          "catalog-v2",
          "raw-prompts",
          "typed-outbound",
          "multi-thread-queue",
          "thread-detail",
          "turn-history",
          "reasoning-control",
          "cancel",
          "local-directory-v1",
          "completion-notifications-v1",
          "presence-notifications-v1",
        ],
      }),
    });
  }

  unregister() {
    return this.request("/service/register", { method: "DELETE" });
  }

  syncCatalog(threads) {
    return this.request("/service/catalog", { method: "PUT", body: JSON.stringify({ threads, complete: true }) });
  }

  claim(threadId, replyId) {
    return this.request(`/threads/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(replyId)}/claim`, { method: "POST" });
  }

  outbound(event, options = {}) {
    return this.request("/service/events/outbound", { ...options, method: "POST", body: JSON.stringify({ event }) });
  }

  serviceStatus() {
    return this.request("/service/status");
  }

  notificationStatus(options = {}) {
    return this.request("/service/notifications", options);
  }

  updateThreadStatus(thread, status) {
    return this.request(`/threads/${encodeURIComponent(thread.id)}/status`, {
      method: "POST",
      body: JSON.stringify({ cwd: thread.projectLabel || "Codex", status, createdAt: new Date().toISOString() }),
    });
  }

  async publishImages(thread, files) {
    const generatedImages = files.slice(0, 5).map((file) => {
      const extension = path.extname(file).toLowerCase();
      const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
      return { filename: path.basename(file), mimeType, dataBase64: readFileSync(file).toString("base64") };
    });
    const result = await this.request(`/threads/${encodeURIComponent(thread.id)}/status`, {
      method: "POST",
      body: JSON.stringify({ cwd: thread.projectLabel || "Codex", status: "idle", createdAt: new Date().toISOString(), generatedImages }),
    });
    if (result?.notification?.sent !== true) {
      throw Object.assign(new Error("Generated output was not delivered."), { code: "MEDIA_DELIVERY_FAILED" });
    }
    return result;
  }

  eventsUrl() {
    const url = new URL(this.apiBaseUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname = "/service/events";
    url.search = "";
    url.searchParams.set("token", this.token);
    return url.toString();
  }

  async downloadImages(threadId, reply) {
    const media = Array.isArray(reply?.media) ? reply.media : [];
    if (media.length > 5) throw new Error("Too many image attachments.");
    const directory = path.join(servicePaths().attachments, threadId.replace(/[^a-zA-Z0-9_.-]/g, "_"), String(reply.id || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "_"));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files = [];
    for (let index = 0; index < media.length; index += 1) {
      const url = typeof media[index]?.url === "string" ? media[index].url : "";
      if (!/^https:\/\//.test(url)) continue;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Image attachment download failed.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Image attachment is too large.");
      const type = response.headers.get("content-type") || "image/jpeg";
      if (!type.startsWith("image/")) continue;
      const ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : type.includes("gif") ? ".gif" : ".jpg";
      const file = path.join(directory, `image-${index + 1}${ext}`);
      writeFileSync(file, bytes, { mode: 0o600 });
      files.push(file);
    }
    return files;
  }
}
