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

/** Profile files copied as they are; credentials (.enc) are never included. */
const profileFiles = [
  "schedules.json",
  "artifact-library.json",
  "artifact-shares.json",
  "reply-feedback.json",
];
const maxFileBytes = 20 * 1024 * 1024;

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
  if (
    /^-/.test(previous) &&
    !previous.includes("=") &&
    secretName.test(previous)
  )
    return redacted;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    return exportedUrl(value) ?? redacted;
  const header = /^([\w-]+)\s*:/.exec(value);
  if (header)
    return secretName.test(header[1]) ? `${header[1]}: ${redacted}` : value;
  const assignment = /^([^=]+)=([\s\S]*)$/.exec(value);
  if (assignment)
    return secretName.test(assignment[1])
      ? `${assignment[1]}=${redacted}`
      : `${assignment[1]}=${exportedArg(assignment[2], "")}`;
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
/** Saved artifact links without the tokens that open them. */
function exportedShares(data: Buffer) {
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "token")
              .map(([key, item]) => [key, strip(item)]),
          )
        : value;
  return Buffer.from(JSON.stringify(strip(parsed), null, 2) + "\n");
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
  if (!snapshot || (!snapshot.docs.length && !snapshot.edits.length))
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

const safeName = (value: string) =>
  value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80) || "Untitled";

function skillFiles(folder: string, prefix: string, entries: ZipEntry[]) {
  if (!fs.existsSync(folder)) return;
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, item.name);
    // Dot folders hold the runtime's own bundled skills.
    if (item.isSymbolicLink() || item.name.startsWith(".")) continue;
    if (item.isDirectory()) skillFiles(full, `${prefix}${item.name}/`, entries);
    else if (item.isFile() && fs.statSync(full).size <= maxFileBytes)
      entries.push({ name: prefix + item.name, data: fs.readFileSync(full) });
  }
}

/**
 * Everything the account keeps on this computer that is its own data:
 * conversations (JSON and Markdown), projects, settings without service
 * details, schedules, saved artifacts, memory and user skills. Incognito chats,
 * keys, MCP server secrets, share tokens and caches are left out.
 */
export function exportEntries(input: {
  root: string;
  conversations: Conversation[];
  projects: Project[];
  settings: Settings;
  now?: Date;
}): ZipEntry[] {
  const json = (value: unknown) =>
    Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const conversations = input.conversations.filter((c) => !c.incognito);
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
          "conversations.json  every saved conversation, with tool activity",
          "conversations/      one Markdown file per conversation",
          "projects.json       projects and their instructions",
          "settings.json       your preferences; MCP servers without their",
          "                    environment variables, headers or tokens",
          "memory.json         what Claudex remembers about you (Settings > Memory)",
          "Other .json files   schedules, saved artifacts and reply ratings",
          "skills/             skills you created or uploaded",
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
    let name = safeName(c.title);
    for (let n = 2; used.has(name); n++) name = `${safeName(c.title)} (${n})`;
    used.add(name);
    entries.push({
      name: `conversations/${name}.md`,
      data: Buffer.from(conversationMarkdown(c)),
      modified: new Date(c.updatedAt),
    });
  });
  for (const file of profileFiles) {
    const full = path.join(input.root, file);
    if (!fs.existsSync(full) || fs.statSync(full).size > maxFileBytes) continue;
    const data = fs.readFileSync(full);
    if (file !== "artifact-shares.json") entries.push({ name: file, data });
    else
      try {
        entries.push({ name: file, data: exportedShares(data) });
      } catch {
        // An unreadable list is left out rather than copied with its tokens.
      }
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
