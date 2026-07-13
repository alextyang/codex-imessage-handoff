import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importImsgAttachments } from "../src/imsg-attachments.mjs";

test("imports only bounded images from the configured Messages attachment tree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "imsg-attachments-"));
  const source = path.join(root, "Messages", "Attachments");
  const destination = path.join(root, "service");
  mkdirSync(path.join(source, "nested"), { recursive: true });
  const image = path.join(source, "nested", "photo.png");
  const document = path.join(source, "nested", "notes.txt");
  writeFileSync(image, "image");
  writeFileSync(document, "private notes");

  const imported = importImsgAttachments([
    { path: image },
    { filename: document },
    { path: "relative.png" },
  ], { sourceRoot: source, destinationRoot: destination, messageKey: "guid/unsafe" });

  assert.equal(imported.length, 1);
  assert.equal(readFileSync(imported[0], "utf8"), "image");
  assert.equal(lstatSync(imported[0]).mode & 0o777, 0o600);
  assert.equal(lstatSync(path.dirname(imported[0])).mode & 0o777, 0o700);
});

test("rejects symlink escapes, missing files, and oversized images", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "imsg-attachments-escape-"));
  const source = path.join(root, "Messages", "Attachments");
  const destination = path.join(root, "service");
  mkdirSync(source, { recursive: true });
  const outside = path.join(root, "outside.png");
  const link = path.join(source, "link.png");
  const oversized = path.join(source, "large.jpg");
  writeFileSync(outside, "outside");
  symlinkSync(outside, link);
  writeFileSync(oversized, Buffer.alloc(10 * 1024 * 1024 + 1));
  chmodSync(oversized, 0o600);

  assert.deepEqual(importImsgAttachments([
    { path: link },
    { path: oversized },
    { path: path.join(source, "missing.png") },
  ], { sourceRoot: source, destinationRoot: destination, messageKey: "guid" }), []);
});
