import { createReadStream, lstatSync } from "node:fs";

const MAX_TITLE_CODE_POINTS = 160;
const MAX_INDEX_LINE_BYTES = 16 * 1024;
const cache = new Map();

function canonicalId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9-]{1,128}$/.test(id) ? id : null;
}

export function normalizeSidebarTitle(value) {
  const title = typeof value === "string"
    ? value.toWellFormed().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return title ? [...title].slice(0, MAX_TITLE_CODE_POINTS).join("") : null;
}

function emptySnapshot() {
  return { titles: new Map(), records: new Map() };
}

function applyLine(line, snapshot) {
  if (!line.length || line.length > MAX_INDEX_LINE_BYTES) return;
  try {
    const record = JSON.parse(line.toString("utf8"));
    const id = canonicalId(record?.id);
    const title = normalizeSidebarTitle(record?.thread_name);
    if (id && title) {
      const parsedUpdatedAt = Date.parse(String(record?.updated_at || ""));
      const updatedAt = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null;
      snapshot.titles.set(id, title);
      snapshot.records.set(id, { title, updatedAt });
    }
  } catch {
    // A concurrently appended partial or malformed record is not authoritative.
  }
}

async function loadIndex(file, createStream = createReadStream, expectedSize = null) {
  const snapshot = emptySnapshot();
  let carry = Buffer.alloc(0);
  let droppingOversizedLine = false;
  let bytesRead = 0;
  const stream = createStream(file, { highWaterMark: 64 * 1024 });
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytesRead += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (!droppingOversizedLine) {
        if (carry.length + segment.length <= MAX_INDEX_LINE_BYTES) {
          if (segment.length) carry = carry.length ? Buffer.concat([carry, segment]) : Buffer.from(segment);
        } else {
          carry = Buffer.alloc(0);
          droppingOversizedLine = true;
        }
      }
      if (newline === -1) break;
      if (!droppingOversizedLine) applyLine(carry, snapshot);
      carry = Buffer.alloc(0);
      droppingOversizedLine = false;
      offset = newline + 1;
    }
  }
  // A complete final JSON record is valid even if the append-only file has no
  // trailing newline. A partial final record simply fails JSON parsing.
  if (Number.isSafeInteger(expectedSize) && bytesRead !== expectedSize) {
    throw new Error("The Codex session index changed during its bounded read.");
  }
  if (!droppingOversizedLine) applyLine(carry, snapshot);
  return snapshot;
}

function signature(file) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The Codex session index is not a regular file.");
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    key: `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`,
  };
}

async function readSnapshot(file, options = {}) {
  const filePath = String(file || "").trim();
  if (!filePath) return emptySnapshot();
  const cached = cache.get(filePath);
  let before;
  try {
    before = signature(filePath);
  } catch {
    return cached?.snapshot || emptySnapshot();
  }
  if (options.bypassCache !== true && cached?.signature.key === before.key) return cached.snapshot;
  // session_index.jsonl is append-only. A same-inode rewrite that does not
  // increase its size is necessarily an incomplete/hostile observation, so it
  // cannot replace a previously complete canonical snapshot.
  if (cached
    && cached.signature.dev === before.dev
    && cached.signature.ino === before.ino
    && before.key !== cached.signature.key
    && before.size <= cached.signature.size) {
    return cached.snapshot;
  }
  try {
    const snapshot = await loadIndex(
      filePath,
      options.createReadStreamImpl || createReadStream,
      before.size,
    );
    const after = signature(filePath);
    if (after.key !== before.key) throw new Error("The Codex session index changed during its bounded read.");
    if (cached && cached.signature.dev === after.dev && cached.signature.ino === after.ino) {
      for (const id of cached.snapshot.records.keys()) {
        if (!snapshot.records.has(id)) {
          throw new Error("The append-only Codex session index lost a prior canonical record.");
        }
      }
    }
    cache.set(filePath, { signature: after, snapshot });
    return snapshot;
  } catch {
    return cached?.snapshot || emptySnapshot();
  }
}

/**
 * Read the append-only title index used by the Codex sidebar. The most recent
 * valid record for each task wins. Failures retain the last good canonical
 * snapshot; callers use a neutral label when no sidebar name has ever existed.
 */
export async function readSidebarTitleIndex(file, options = {}) {
  return (await readSnapshot(file, options)).titles;
}

/** Latest title plus its persisted Codex timestamp, for notification ordering. */
export async function readSidebarTitleRecords(file, options = {}) {
  return (await readSnapshot(file, options)).records;
}

export function clearSidebarTitleIndexCache() {
  cache.clear();
}

export const sidebarTitleIndexInternals = Object.freeze({
  maxIndexLineBytes: MAX_INDEX_LINE_BYTES,
  loadIndex,
});
