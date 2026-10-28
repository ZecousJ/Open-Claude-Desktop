import type { MemoryDocView, MemoryStatus } from "../../shared/memory-api";

/** The project page's Memory section text when the project has none yet. */
export const projectMemoryEmpty =
  "Project memory will show here after a few chats.";

/**
 * Whether a project page shows its Memory section (design 4.2): memory is
 * usable and Generate is on. Otherwise nothing shows, not a dead control.
 */
export const showsProjectMemory = (status: MemoryStatus | undefined) =>
  Boolean(status?.available && status.prefs.generate);

/**
 * The memory as one plain line: headings dropped, list marks, emphasis, code
 * ticks and links reduced to their words, line breaks to spaces.
 */
export function flattenMemory(text: string | undefined) {
  if (!text) return "";
  return text
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^[^\S\n]*[-*+]\s+(.+)$/gm, "$1")
    .replace(/^[^\S\n]*\d+\.\s+(.+)$/gm, "$1")
    .replace(/^[^\S\n]*[-*+]\s+\[[x ]\]\s+(.+)$/gm, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/___([^_]+)___/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
}

/** The section's preview: the project's memory, or the empty text. */
export const projectMemoryPreview = (doc: MemoryDocView | null | undefined) =>
  doc?.content.trim() || projectMemoryEmpty;

/**
 * What the section shows: a placeholder while the first read runs, the
 * failure line with Try again, the empty line, or the memory (with Edit).
 * A failed re-read keeps showing memory already read, as the live page does
 * (it only reports the failure while it has nothing).
 */
export function projectMemoryState(
  doc: MemoryDocView | null | undefined,
  failed: boolean,
): "loading" | "failed" | "empty" | "memory" {
  if (doc?.content.trim()) return "memory";
  if (failed) return "failed";
  if (doc === undefined) return "loading";
  return "empty";
}
