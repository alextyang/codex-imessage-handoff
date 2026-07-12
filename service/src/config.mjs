import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { servicePaths } from "./paths.mjs";

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writePrivateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export function importLegacyConfig() {
  const paths = servicePaths();
  if (existsSync(paths.config)) return readJson(paths.config);
  if (!existsSync(paths.legacyConfig)) return null;
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  copyFileSync(paths.legacyConfig, paths.config);
  chmodSync(paths.config, 0o600);
  return readJson(paths.config);
}

export async function configureRelay(apiBaseUrl) {
  const normalized = String(apiBaseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(normalized) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(normalized)) {
    throw new Error("Relay URL must use HTTPS or local 127.0.0.1 HTTP.");
  }
  const response = await fetch(`${normalized}/installations`, { method: "POST" });
  const body = await response.json();
  if (!response.ok || typeof body.token !== "string") throw new Error("Relay did not create an install token.");
  const config = { apiBaseUrl: normalized, token: body.token, clientId: randomBytes(16).toString("hex") };
  writePrivateJson(servicePaths().config, config);
  return config;
}

export function readConfig() {
  const config = importLegacyConfig();
  if (!config?.apiBaseUrl || !config?.token) {
    throw new Error("iMessage service is not configured. Run install with --relay=https://your-relay.");
  }
  if (!config.clientId) {
    config.clientId = randomBytes(16).toString("hex");
    writePrivateJson(servicePaths().config, config);
  }
  return { ...config, apiBaseUrl: String(config.apiBaseUrl).replace(/\/+$/, "") };
}
