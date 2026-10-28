import { formatText } from "../../i18n";

/**
 * What the Upload a skill page shows under "Preview" once a file is chosen And
 * whether the file is a zip at all ("Invalid zip file"). Only a peek: the
 * installation itself (and its full checks) stays in the main process.
 */
export interface SkillPreview {
  name: string;
  description?: string;
  /** Why the file cannot be a skill, when it plainly cannot. */
  error?: string;
}

/** The `name` and `description` of a SKILL.md front matter. */
export function readFrontMatter(markdown: string): {
  name?: string;
  description?: string;
} {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const result: { name?: string; description?: string } = {};
  if (!front) return result;
  const lines = front[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(name|description)\s*:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    let value = match[2].trim();
    // A folded or literal block: the indented lines that follow.
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]))
        block.push(lines[++i].trim());
      value = block.join(" ");
    } else if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.replace(/^"|"$/g, "");
      }
    } else value = value.replace(/^'|'$/g, "");
    if (value) result[match[1] as "name" | "description"] = value;
  }
  return result;
}

const utf8 = new TextDecoder();

/** SKILL.md of a zip (at the top or one folder down), or an error. */
async function zippedManifest(
  bytes: Uint8Array,
): Promise<{ text?: string; error?: string }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) return { error: "Invalid zip file" };
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const found: { method: number; packed: number; local: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      return { error: "Invalid zip file" };
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = utf8
      .decode(bytes.subarray(at + 46, at + 46 + nameLength))
      .replace(/\\/g, "/");
    at += 46 + nameLength + extra + comment;
    if (
      /(^|\/)SKILL\.md$/.test(name) &&
      name.split("/").length <= 2 &&
      !name.startsWith("__MACOSX/")
    )
      found.push({ method, packed, local });
  }
  if (found.length !== 1)
    return {
      error: "The archive needs one SKILL.md at its top or in one folder.",
    };
  const { method, packed, local } = found[0];
  if (local + 30 > bytes.length) return { error: "Invalid zip file" };
  const start =
    local +
    30 +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  const data = bytes.subarray(start, start + packed);
  if (method === 0) return { text: utf8.decode(data) };
  if (method !== 8) return { error: "Invalid zip file" };
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return { text: await new Response(stream).text() };
  } catch {
    return { error: "Invalid zip file" };
  }
}

/** The file name without its extension: the name shown when the file has none. */
export const skillFileBase = (fileName: string) =>
  fileName.replace(/\.(md|zip|skill)$/i, "");

export async function previewSkillFile(file: File): Promise<SkillPreview> {
  const base = skillFileBase(file.name);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".md")) {
      const front = readFrontMatter(utf8.decode(bytes));
      return { name: front.name ?? base, description: front.description };
    }
    const { text, error } = await zippedManifest(bytes);
    if (error || text === undefined) return { name: base, error };
    const front = readFrontMatter(text);
    return { name: front.name ?? base, description: front.description };
  } catch {
    return { name: base, error: "Invalid zip file" };
  }
}

/** "54B", "1.2KB", "3.4MB": the size next to a chosen file's name. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** What the page says when files are refused for their extension. */
export function leftOutMessage(refused: number, chosen: number) {
  if (chosen === 1)
    return "Skill files must have a .skill, .zip, or .md file extension.";
  return formatText(
    refused === 1
      ? "{count} file was left out: skill files must have a .skill, .zip, or .md file extension."
      : "{count} files were left out: skill files must have a .skill, .zip, or .md file extension.",
    { count: refused },
  );
}
