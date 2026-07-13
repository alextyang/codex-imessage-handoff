import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { servicePaths } from "./paths.mjs";

const CONFIG_VERSION = 4;
const CONFIG_KEYS = new Set(["version", "imsg"]);
const IMSG_KEYS = new Set([
  "mode",
  "clientConfig",
  "chatId",
  "chatGuid",
  "expectedSender",
  "featureMode",
  "presentation",
  "polls",
  "reactions",
]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function nonempty(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function validatePrivateClientConfig(file) {
  const clientConfig = nonempty(file);
  if (!clientConfig || !path.isAbsolute(clientConfig)) {
    throw new Error("imsg helper client config must be an absolute path.");
  }
  let metadata;
  try {
    metadata = statSync(clientConfig);
  } catch {
    throw new Error("imsg helper client config does not exist.");
  }
  if (!metadata.isFile()) throw new Error("imsg helper client config must be a regular file.");
  if ((metadata.mode & 0o077) !== 0) throw new Error("imsg helper client config must not be accessible by group or other users.");
  return clientConfig;
}

function normalizeImsg(value) {
  if (!value || typeof value !== "object") throw new Error("The authenticated local imsg helper is not configured.");
  if (value.mode !== undefined && value.mode !== "helper") {
    throw new Error("Direct/local imsg mode is no longer supported; configure the authenticated helper.");
  }
  const unknown = Object.keys(value).filter((key) => !IMSG_KEYS.has(key));
  if (unknown.length) throw new Error(`Unsupported local imsg configuration field: ${unknown[0]}.`);
  const clientConfig = validatePrivateClientConfig(value.clientConfig);
  const chatId = Number(value.chatId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("imsg chat id must be a positive integer.");
  const chatGuid = nonempty(value.chatGuid);
  if (!chatGuid) throw new Error("imsg chat GUID is required.");
  const expectedSender = nonempty(value.expectedSender);
  if (!expectedSender) throw new Error("imsg expected sender is required.");
  if (value.featureMode !== undefined && value.featureMode !== "bridge") {
    throw new Error("Only full bridge mode is supported.");
  }
  if (value.presentation !== undefined && value.presentation !== "rich") {
    throw new Error("Only rich presentation is supported.");
  }
  if (value.polls !== undefined && value.polls !== true) throw new Error("Native polls must be enabled.");
  if (value.reactions !== undefined && value.reactions !== true) throw new Error("Native reactions must be enabled.");
  return {
    mode: "helper",
    clientConfig,
    chatId,
    chatGuid,
    expectedSender,
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
  };
}

export function normalizeConfig(value) {
  if (!value || typeof value !== "object") throw new Error("iMessage service configuration is invalid.");
  if (Number(value.version) !== CONFIG_VERSION || !value.imsg) {
    throw new Error("This release requires a current authenticated local imsg helper configuration.");
  }
  const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) throw new Error(`Unsupported iMessage service configuration field: ${unknown[0]}.`);
  return { version: CONFIG_VERSION, imsg: normalizeImsg(value.imsg) };
}

export function writePrivateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  const temporaryFd = openSync(temporary, "r");
  try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
  renameSync(temporary, file);
  try {
    const directoryFd = openSync(path.dirname(file), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch {
    // The file is already synced and atomically renamed; directory fsync is
    // unavailable on a small number of supported filesystems.
  }
}

export function configureImsg(options) {
  const config = { version: CONFIG_VERSION, imsg: normalizeImsg(options) };
  writePrivateJson(servicePaths().config, config);
  return config;
}

export function transportStatus(config = readConfig()) {
  return {
    transport: "imsg",
    configured: true,
    mode: "helper",
    clientConfig: "<redacted>",
    chatId: config.imsg.chatId,
    chatGuid: "<redacted>",
    expectedSender: "<redacted>",
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
  };
}

export function readConfig() {
  const file = servicePaths().config;
  if (!existsSync(file)) {
    throw new Error("The local iMessage helper is not configured. Run transport finish-helper after helper setup.");
  }
  const raw = readJson(file);
  const config = normalizeConfig(raw);
  if (JSON.stringify(raw) !== JSON.stringify(config)) writePrivateJson(file, config);
  return config;
}

export const configValues = Object.freeze({
  version: CONFIG_VERSION,
  transport: "imsg",
  mode: "helper",
  featureMode: "bridge",
  presentation: "rich",
});
