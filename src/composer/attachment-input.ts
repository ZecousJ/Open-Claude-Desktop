import type { Attachment } from "../../shared/types";
import "../../shared/composer-api";

/**
 * Pasting and dropping into the composer. Files go through the main process's
 * attachment rules (`addAttachmentData`); long pasted text becomes a Pasted
 * card instead of filling the composer.
 */

/**
 * Pasted text of at least this many UTF-8 bytes is kept as a Pasted attachment;
 * shorter text goes into the box.
 */
export const pastedTextThreshold = 4_096;

/** Whether pasted text becomes a Pasted card rather than composer text. */
export function pastesAsCard(text: string) {
  return new TextEncoder().encode(text).byteLength >= pastedTextThreshold;
}

const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * The name a pasted or dropped file is kept under. A clipboard image is
 * often called "image.png"; it keeps its type's extension.
 */
export function incomingFileName(file: { name: string; type: string }) {
  const extension = imageExtensions[file.type];
  if (file.name && /\.[a-z0-9]+$/i.test(file.name)) return file.name;
  if (extension) return `Pasted image.${extension}`;
  return file.name || "Attachment";
}

// Local data for cards, kept for the window's lifetime.
const previews = new Map<string, string>();
const pasted = new Map<string, string>();
const excerpts = new Map<string, string>();

/** A pasted or dropped image's local thumbnail. */
export const attachmentPreviewUrl = (id: string) => previews.get(id);
/** The text a Pasted card shows. */
export const pastedText = (id: string) => pasted.get(id);

/** For a card made by Attach selection as context: the terminal's name, else undefined. */
export const excerptLabel = (id: string) => excerpts.get(id);

/** Keeps a dropped or pasted file as an attachment. */
export async function addFile(file: File): Promise<Attachment> {
  const data = new Uint8Array(await file.arrayBuffer());
  const attachment = await window.desktop.addAttachmentData(
    incomingFileName(file),
    data,
  );
  if (attachment.kind === "image")
    previews.set(attachment.id, URL.createObjectURL(file));
  return attachment;
}

/** Keeps long pasted text as a Pasted attachment. */
export async function addPastedText(text: string): Promise<Attachment> {
  const attachment = await window.desktop.addAttachmentData(
    "Pasted text.txt",
    new TextEncoder().encode(text),
    { pasted: true },
  );
  pasted.set(attachment.id, text);
  return attachment;
}

/**
 * Keeps a terminal selection as an excerpt card (Attach selection as context).
 * The original adds a quote snippet named after the terminal tab; here it is a
 * Pasted-style card whose text file carries the selection, since the composer
 * has no inline quote chips.
 */
export async function addTerminalExcerpt(
  text: string,
  label: string,
): Promise<Attachment> {
  const attachment = await window.desktop.addAttachmentData(
    `${label}.txt`,
    new TextEncoder().encode(text),
    { pasted: true },
  );
  pasted.set(attachment.id, text);
  excerpts.set(attachment.id, label);
  return attachment;
}

/** Whether a drag carries files from outside the window. */
export function dragHasFiles(types: readonly string[]) {
  return types.includes("Files");
}
