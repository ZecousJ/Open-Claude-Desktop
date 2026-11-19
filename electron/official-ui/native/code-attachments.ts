import { z } from "zod";
import type { Attachment } from "../../../shared/types";
import fs from "node:fs";
import path from "node:path";

const MAX_BASE64_LENGTH = 43_000_000;
function base64Digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}

// A bounded linear scan avoids the repeated-group regexp's stack overflow on
// ordinary multi-megabyte attachments. Check canonical padding without decoding.
function validBase64(value: string): boolean {
  if (value.length > MAX_BASE64_LENGTH || value.length % 4 !== 0) return false;
  if (!value.length) return true;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  for (let i = 0; i < end; i++) {
    if (base64Digit(value.charCodeAt(i)) < 0) return false;
  }
  const last = base64Digit(value.charCodeAt(end - 1));
  return padding === 2
    ? (last & 15) === 0
    : padding === 1
      ? (last & 3) === 0
      : true;
}

function decodedSize(value: string): number {
  return (
    (value.length / 4) * 3 -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
  );
}

const base64 = z
  .string()
  .max(MAX_BASE64_LENGTH)
  .refine(validBase64, "Invalid attachment encoding");
const image = z
  .object({
    base64,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  })
  .strict();
const file = z
  .object({
    name: z.string().min(1).max(500),
    base64,
    readFailed: z.boolean().optional(),
  })
  .strict();
const ext = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function codeComposerFileReferences(text: string) {
  const prefix = codeComposerFilePrefix(text);
  return prefix
    ? Array.from(prefix.matchAll(/@"([^"\r\n]+)"/g), ([, file]) => file).filter(
        (file) => path.isAbsolute(file) && path.normalize(file) === file,
      )
    : [];
}

const codeComposerFilePrefix = (text: string) =>
  /^(?:@"[^"\r\n]+" ?)+(?=\r?\n|$)/.exec(text)?.[0];

export function queuedCodeComposerText(text: string, files: Attachment[]) {
  const prefix = codeComposerFilePrefix(text);
  const documents = files.filter((file) => file.kind !== "image");
  if (!documents.length) return text;
  const names = new Set(documents.map((file) => file.name));
  const previous = prefix
    ? [...prefix.matchAll(/@"([^"\r\n]+)"/g)]
        .filter(([, file]) => !names.has(path.basename(file)))
        .map(([ref]) => ref)
    : [];
  return [
    [...documents.map((file) => `@"${file.path}"`), ...previous].join(" "),
    prefix ? text.slice(prefix.length).replace(/^\r?\n/, "") : text,
  ].join("\n");
}
export function storedAttachmentImage(root: string | undefined, a: Attachment) {
  if (!root || a.kind !== "image") return null;
  try {
    const store = fs.realpathSync(path.join(root, "attachments")),
      file = fs.realpathSync(a.path);
    if (
      !file.startsWith(store + path.sep) ||
      fs.statSync(file).size > 20 * 1024 * 1024
    )
      return null;
    const mime = Object.entries(ext).find(
      ([, e]) =>
        e === path.extname(a.name).slice(1).toLowerCase() ||
        (e === "jpg" && path.extname(a.name).toLowerCase() === ".jpeg"),
    )?.[0];
    return mime
      ? { mime, base64: fs.readFileSync(file).toString("base64") }
      : null;
  } catch {
    return null;
  }
}

/** Official qC/gR wire payloads; no renderer-supplied local paths are read. */
export async function storeCodeAttachments(
  call: (name: string, ...args: unknown[]) => Promise<unknown>,
  images: unknown,
  files: unknown,
  selected?: (budget: number) => Array<{ name: string; data: Uint8Array }>,
): Promise<Attachment[]> {
  const pictures = z
      .array(image)
      .max(12)
      .parse(images ?? []),
    documents = z
      .array(file)
      .max(12)
      .parse(files ?? []);
  if (pictures.length + documents.length > 12)
    throw Error("Attach at most 12 files.");
  if (documents.some((f) => f.readFailed))
    throw Error("An attachment could not be read. Remove it and add it again.");
  // Reject oversized batches before allocating any decoded buffers.
  const limit = 64 * 1024 * 1024;
  const bytes = [...pictures, ...documents].reduce(
    (n, f) => n + decodedSize(f.base64),
    0,
  );
  if (bytes > limit)
    throw Error("Combined attachments exceed 64 MB.");
  const picked = selected?.(limit - bytes) ?? [];
  if (pictures.length + documents.length + picked.length > 12)
    throw Error("Attach at most 12 files.");
  const payload = [
    ...pictures.map((p, i) => ({
      name: "image-" + (i + 1) + "." + ext[p.mimeType],
      data: Uint8Array.from(Buffer.from(p.base64, "base64")),
    })),
    ...documents.map((f) => ({
      name: f.name,
      data: Uint8Array.from(Buffer.from(f.base64, "base64")),
    })),
    ...picked,
  ];
  if (!payload.length) return [];
  return (await call("officialStoreCodeAttachments", payload)) as Attachment[];
}
