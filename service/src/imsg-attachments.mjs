import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function attachmentPath(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return typeof value.path === "string"
    ? value.path
    : typeof value.filename === "string"
      ? value.filename
      : "";
}

function safeSegment(value) {
  return String(value || "message").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "message";
}

/**
 * Copy only supported image attachments out of Messages' private attachment
 * tree into the service-owned queue. Resolving both paths first rejects
 * traversal and symlink escapes before Codex receives a local filename.
 */
export function importImsgAttachments(attachments, options = {}) {
  const values = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
  if (!values.length) return [];
  if (!options.destinationRoot) throw new TypeError("A destinationRoot is required.");
  const sourceRoot = realpathSync(options.sourceRoot || path.join(os.homedir(), "Library", "Messages", "Attachments"));
  const destination = path.join(path.resolve(options.destinationRoot), safeSegment(options.messageKey));
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);

  const imported = [];
  for (const value of values) {
    const sourceValue = attachmentPath(value);
    if (!sourceValue || !path.isAbsolute(sourceValue)) continue;
    let source;
    let stat;
    try {
      source = realpathSync(sourceValue);
      stat = statSync(source);
    } catch {
      continue;
    }
    const extension = path.extname(source).toLowerCase();
    if (!inside(sourceRoot, source) || !stat.isFile() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES || !IMAGE_EXTENSIONS.has(extension)) continue;
    const target = path.join(destination, `image-${imported.length + 1}${extension === ".jpeg" ? ".jpg" : extension}`);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    imported.push(target);
  }
  return imported;
}

export const imsgAttachmentLimits = Object.freeze({
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  imageExtensions: [...IMAGE_EXTENSIONS],
});
