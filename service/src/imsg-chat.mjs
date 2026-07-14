import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const MESSAGE_LOOKUP_MAX_BYTES = 64 * 1024;

function participantValue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of ["handle", "identifier", "address", "id"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

export function inspectLocalImsgChat({ binary, chatId, run = execFileSync } = {}) {
  const id = Number(chatId);
  if (typeof binary !== "string" || !binary || !Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error("The selected local Messages chat is invalid."), { code: "IMSG_CHAT_INVALID" });
  }
  let stdout;
  try {
    stdout = run(binary, ["group", "--chat-id", String(id), "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    throw Object.assign(new Error("The selected local Messages chat could not be inspected safely."), { code: "IMSG_CHAT_UNAVAILABLE" });
  }
  let rows;
  try {
    rows = String(stdout || "").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    throw Object.assign(new Error("The selected local Messages chat returned invalid metadata."), { code: "IMSG_CHAT_INVALID" });
  }
  const chat = rows.length === 1 ? rows[0] : null;
  const chatGuid = typeof chat?.guid === "string" ? chat.guid.trim() : "";
  if (!chat || Number(chat.id) !== id || !chatGuid) {
    throw Object.assign(new Error("The selected local Messages chat no longer matches its configuration."), { code: "IMSG_CHAT_MISMATCH" });
  }
  return {
    chatId: id,
    chatGuid,
    service: typeof chat.service === "string" ? chat.service.trim() : "",
    isGroup: chat.is_group === true,
    participants: (Array.isArray(chat.participants) ? chat.participants : []).map(participantValue).filter(Boolean),
  };
}

export function inspectLocalImsgMessage({
  chatId,
  messageGuid,
  database = path.join(os.homedir(), "Library", "Messages", "chat.db"),
  sqliteBinary = "/usr/bin/sqlite3",
  run = execFileSync,
} = {}) {
  const id = Number(chatId);
  const guid = typeof messageGuid === "string" ? messageGuid.trim() : "";
  if (!Number.isSafeInteger(id) || id <= 0 || !guid || Buffer.byteLength(guid, "utf8") > 4096) {
    throw Object.assign(new Error("The selected local Messages item is invalid."), { code: "IMSG_MESSAGE_INVALID" });
  }
  if (!path.isAbsolute(database) || !path.isAbsolute(sqliteBinary)) {
    throw Object.assign(new Error("The local Messages database lookup is invalid."), { code: "IMSG_MESSAGE_INVALID" });
  }

  // Encode the untrusted GUID as a SQLite blob literal. This avoids SQL
  // interpolation while keeping the query exact and content-free.
  const guidHex = Buffer.from(guid, "utf8").toString("hex");
  const query = `
    SELECT
      m.guid AS guid,
      cmj.chat_id AS chat_id,
      m.is_from_me AS is_from_me,
      h.id AS sender
    FROM message AS m
    JOIN chat_message_join AS cmj ON cmj.message_id = m.ROWID
    LEFT JOIN handle AS h ON h.ROWID = m.handle_id
    WHERE cmj.chat_id = ${id}
      AND m.guid = CAST(X'${guidHex}' AS TEXT)
    LIMIT 2
  `;
  let stdout;
  try {
    stdout = run(sqliteBinary, [
      "-readonly",
      "-json",
      "-cmd",
      ".timeout 5000",
      database,
      query,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      maxBuffer: MESSAGE_LOOKUP_MAX_BYTES,
    });
  } catch {
    throw Object.assign(new Error("The local Messages item could not be inspected safely."), { code: "IMSG_MESSAGE_LOOKUP_UNAVAILABLE" });
  }

  const output = String(stdout || "").trim();
  if (Buffer.byteLength(output, "utf8") > MESSAGE_LOOKUP_MAX_BYTES) {
    throw Object.assign(new Error("The local Messages item lookup was too large."), { code: "IMSG_MESSAGE_LOOKUP_INVALID" });
  }
  let rows;
  try {
    rows = output ? JSON.parse(output) : [];
  } catch {
    throw Object.assign(new Error("The local Messages item lookup returned invalid metadata."), { code: "IMSG_MESSAGE_LOOKUP_INVALID" });
  }
  if (!Array.isArray(rows) || rows.length > 1) {
    throw Object.assign(new Error("The local Messages item lookup was ambiguous."), { code: "IMSG_MESSAGE_LOOKUP_INVALID" });
  }
  const row = rows[0];
  if (!row) return null;
  if (typeof row !== "object" || Array.isArray(row)
    || row.guid !== guid || Number(row.chat_id) !== id
    || ![0, 1, false, true].includes(row.is_from_me)) {
    throw Object.assign(new Error("The local Messages item no longer matches its conversation."), { code: "IMSG_MESSAGE_LOOKUP_INVALID" });
  }
  return {
    guid,
    chat_id: id,
    is_from_me: row.is_from_me === 1 || row.is_from_me === true,
    sender: typeof row.sender === "string" ? row.sender.trim() : "",
  };
}
