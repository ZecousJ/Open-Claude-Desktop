/**
 * What an attachment tile in the composer says about a text file and how it
 * names it.
 */

/** Lines in a text file: a final line break does not start another one. */
export function countLines(bytes: Uint8Array) {
  if (!bytes.length) return 0;
  let lines = 1;
  for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 10) lines++;
  return lines;
}

/** "1 line", "8 lines". */
export function formatLines(lines: number) {
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

/**
 * A long file name cut in the middle, the extension kept: R-1093 shows
 * "synthetic-lon…" over "-removal.txt", 13 characters, an ellipsis and 12.
 */
export function shortenAttachmentName(name: string) {
  const head = 13;
  const tail = 12;
  const chars = Array.from(name);
  if (chars.length <= head + tail + 1) return name;
  return `${chars.slice(0, head).join("")}…${chars.slice(-tail).join("")}`;
}
