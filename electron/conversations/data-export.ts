import fs from "node:fs";
import path from "node:path";
import type { Conversation, Project, Settings } from "../../shared/types";
import { createZip, type ZipEntry } from "../workspace/zip";
import { LocalMemoryStore, localMemoryFile } from "../memory/local-store";
import { readMemoryCache } from "../memory/remote-store";
import type { MemorySnapshot } from "../memory/types";

/** A conversation as Markdown: each prompt and the replies' text. */
export function conversationMarkdown(c: Conversation) {
  return (
    `# ${c.title}\n\n` +
    c.turns
      .map(
        (t) =>
          `## You\n\n${t.prompt}\n\n## Claudex\n\n${t.items
            .filter((i) => i.type === "agentMessage")
            .map((i) => i.text ?? "")
            .join("\n\n")}`,
      )
      .join("\n\n---\n\n")
  );
}

const profileFiles = [
  "schedules.json",
  "artifact-library.json",
  "artifact-shares.json",
  "reply-feedback.json",
];
const maxSkillFileBytes = 20 * 1024 * 1024;

const secretName =
  /token|secret|password|passwd|api[-_]?key|auth|credential|cookie|bearer/i;
const redacted = "<redacted>";

/**
 * One argument as the export shows it: the value after a secret-looking flag
 * (`--api-key sk-…`, `--token=…`) and secret headers (`Authorization: …`)
 * are replaced; addresses such as database URLs lose their user name,
 * password, query and fragment.
 */
function exportedArg(value: string, previous: string): string {
  const header = /^([\w-]+)\s*:/.exec(value);
  if (previous === "--header" || previous === "-H")
    return header ? `${header[1]}: ${redacted}` : redacted;
  if (
    /^-/.test(previous) &&
    !previous.includes("=") &&
    secretName.test(previous)
  )
    return redacted;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    return exportedUrl(value) ?? redacted;
  if (header)
    return secretName.test(header[1]) ? `${header[1]}: ${redacted}` : value;
  const assignment = /^([^=]+)=([\s\S]*)$/.exec(value);
  if (assignment)
    return secretName.test(assignment[1])
      ? `${assignment[1]}=${redacted}`
      : `${assignment[1]}=${exportedArg(assignment[2], assignment[1])}`;
  return /^bearer\s/i.test(value) ? redacted : value;
}
function exportedArgs(args: unknown) {
  if (!Array.isArray(args)) return undefined;
  return args.map((arg, index) =>
    exportedArg(String(arg), index > 0 ? String(args[index - 1]) : ""),
  );
}
/** An address without user name, password, query or fragment. */
function exportedUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}
/**
 * MCP servers as the export shows them: what runs and where, never the
 * environment variables, headers or tokens that authenticate them.
 */
export function exportedMcpServers(servers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, raw]) => {
      const server = (
        raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
      ) as Record<string, unknown>;
      const entry: Record<string, unknown> = {};
      if (typeof server.command === "string") entry.command = server.command;
      const args = exportedArgs(server.args);
      if (args) entry.args = args;
      const url = exportedUrl(server.url);
      if (url) entry.url = url;
      if (typeof server.enabled === "boolean") entry.enabled = server.enabled;
      return [name, entry];
    }),
  );
}
function withoutShareTokens(data: Buffer) {
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  return Buffer.from(
    JSON.stringify(
      parsed,
      (key, value: unknown) =>
        key === "token" || key === "sharedArtifactToken" ? undefined : value,
      2,
    ) + "\n",
  );
}

/**
 * The account's memory (R3) as the export shows it: the switches, each
 * scope's text and the "remember this" statements. A Claudex account's
 * memory lives on the service; its cached copy on this computer is used.
 */
export function exportedMemory(root: string) {
  let snapshot: MemorySnapshot | undefined;
  if (fs.existsSync(path.join(root, localMemoryFile))) {
    const local = new LocalMemoryStore(root);
    // An unreadable file is left out rather than exported as empty.
    if (!local.unreadable) snapshot = local.current();
  } else snapshot = readMemoryCache(root);
  if (
    !snapshot ||
    (!snapshot.prefs && !snapshot.docs.length && !snapshot.edits.length)
  )
    return undefined;
  const iso = (at: number) => new Date(at).toISOString();
  return {
    ...(snapshot.prefs ? { switches: snapshot.prefs } : {}),
    documents: snapshot.docs
      .filter((doc) => doc.content !== null)
      .map((doc) => ({
        scope: doc.scope,
        content: doc.content,
        source: doc.source,
        updatedAt: iso(doc.updatedAt),
      })),
    edits: snapshot.edits
      .filter((edit) => edit.text !== null)
      .map((edit) => ({
        scope: edit.scope,
        text: edit.text,
        createdAt: iso(edit.createdAt),
      })),
  };
}

function safeName(value: string) {
  const name =
    value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80) || "Untitled";
  return /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³]) *(?:\.|$)/iu.test(name)
    ? `_${name}`
    : name;
}
const extractionKey = (name: string) => name.normalize("NFC").toLowerCase();

function skillFiles(folder: string, prefix: string, entries: ZipEntry[]) {
  if (!fs.existsSync(folder)) return;
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, item.name);
    // Dot folders hold the runtime's own bundled skills.
    if (item.isSymbolicLink() || item.name.startsWith(".")) continue;
    if (item.isDirectory()) skillFiles(full, `${prefix}${item.name}/`, entries);
    else if (item.isFile() && fs.statSync(full).size <= maxSkillFileBytes)
      entries.push({ name: prefix + item.name, data: fs.readFileSync(full) });
  }
}

/**
 * A snapshot of the account's selected local history and profile data.
 * Incognito chats, credentials, and share tokens are left out.
 */
export function exportEntries(input: {
  root: string;
  conversations: Conversation[];
  projects: Project[];
  settings: Settings;
  conversationRange?: { start?: number; end?: number };
  now?: Date;
}): ZipEntry[] {
  const json = (value: unknown) =>
    Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const { start, end } = input.conversationRange ?? {};
  const conversations = input.conversations.filter(
    (c) =>
      !c.incognito &&
      (start === undefined || c.createdAt >= start) &&
      (end === undefined || c.createdAt < end),
  );
  const { providers: _providers, ...settings } = input.settings;
  settings.mcpServers = exportedMcpServers(settings.mcpServers);
  const entries: ZipEntry[] = [
    {
      name: "README.txt",
      data: Buffer.from(
        [
          "Claudex data export",
          `Created ${(input.now ?? new Date()).toISOString()}`,
          "",
          "conversations.json  saved conversations in the chosen date range",
          "                    with tool activity",
          "conversations/      one Markdown file per exported conversation",
          "projects.json       projects and their instructions",
          "settings.json       your preferences; MCP servers without their",
          "                    environment variables or header values",
          "memory.json         what Claudex remembers about you (Settings > Memory)",
          "Other .json files   schedules, saved artifacts and reply ratings",
          "skills/             skills you created or uploaded",
          "",
          "This export contains data available on this computer. It does not",
          "include incognito chats, cloud-only history, separate attachment",
          "files, or workspace files.",
          "",
        ].join("\n"),
      ),
    },
    { name: "conversations.json", data: json(conversations) },
    { name: "projects.json", data: json(input.projects) },
    { name: "settings.json", data: json(settings) },
  ];
  const used = new Set<string>();
  conversations.forEach((c) => {
    const stem = safeName(c.title);
    let name = stem;
    for (let n = 2; used.has(extractionKey(name)); n++) name = `${stem} (${n})`;
    used.add(extractionKey(name));
    entries.push({
      name: `conversations/${name}.md`,
      data: Buffer.from(conversationMarkdown(c)),
      modified: new Date(c.updatedAt),
    });
  });
  for (const file of profileFiles) {
    const full = path.join(input.root, file);
    if (!fs.existsSync(full)) continue;
    const data = fs.readFileSync(full);
    if (file === "artifact-shares.json" || file === "artifact-library.json") {
      try {
        entries.push({ name: file, data: withoutShareTokens(data) });
      } catch {
        // A file that cannot be redacted is not exported.
      }
    } else entries.push({ name: file, data });
  }
  const memory = exportedMemory(input.root);
  if (memory) entries.push({ name: "memory.json", data: json(memory) });
  skillFiles(path.join(input.root, "codex-home", "skills"), "skills/", entries);
  return entries;
}

/** The export as the .zip Settings → Privacy → Export data saves. */
export function exportArchive(input: Parameters<typeof exportEntries>[0]) {
  return createZip(exportEntries(input));
}
