import { attachmentFileName } from "./composer-files";
import { builtInAttachmentBytes } from "../../shared/client-policy";

export function prepareDerivedTextAttachment(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid extracted text attachment.");
  const input = value as Record<string, unknown>;
  if (
    typeof input.extractedContent !== "string" ||
    (input.fileName !== undefined && typeof input.fileName !== "string") ||
    (typeof input.fileName === "string" && input.fileName.length > 500) ||
    (input.fileType !== undefined &&
      (typeof input.fileType !== "string" || input.fileType.length > 500))
  )
    throw Error("Invalid extracted text attachment.");
  // fileSize describes the original source, not the extracted UTF-8 payload.
  // Never pass it through as the derived attachment's size or trust its MIME.
  const text = input.extractedContent;
  if (text.length > builtInAttachmentBytes.text || text.includes("\0"))
    throw Error("Extracted text exceeds its limit or contains binary data.");
  const data = new TextEncoder().encode(text);
  if (
    data.byteLength > builtInAttachmentBytes.text ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data) !==
      text
  )
    throw Error(
      "Extracted text must be valid UTF-8 within the text attachment limit.",
    );
  const suffix = ".extracted.txt";
  const source = attachmentFileName(
    Buffer.from((input.fileName as string) || "pasted").toString("utf8"),
  );
  let prefix = "";
  for (const character of source) {
    if (prefix.length + character.length > 120 - suffix.length) break;
    prefix += character;
  }
  return {
    name: `${prefix || "attachment"}${suffix}`,
    data,
    mediaType: "text/plain" as const,
  };
}
