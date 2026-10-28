import fs from "node:fs";
import path from "node:path";
import type { Attachment } from "../../shared/types";

/** Largest text attachment inlined into a prompt. */
export const maxTextAttachmentBytes = 2 * 1024 * 1024;

/** Largest image sent as data to an engine on another computer. */
const maxInlineImageBytes = 20 * 1024 * 1024;

const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function imageDataUrl(file: Attachment) {
  if (fs.statSync(file.path).size > maxInlineImageBytes)
    throw new Error("Images can't be larger than 20 MB.");
  const type =
    imageTypes[path.extname(file.name || file.path).toLowerCase()] ??
    imageTypes[path.extname(file.path).toLowerCase()] ??
    "image/png";
  return `data:${type};base64,${fs.readFileSync(file.path).toString("base64")}`;
}
