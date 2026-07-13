import { execFileSync } from "node:child_process";

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
