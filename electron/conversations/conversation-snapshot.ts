/**
 * What a shared conversation shows (R1, design 3.2 and 5.4): the prompts,
 * the replies' text and the text files the replies wrote, from the
 * conversation's current branch. Nothing else leaves the computer: no
 * attachments or images, no reasoning, no commands or their output, no
 * approvals, no MCP results, no file paths, no account or device details.
 * A reply's tools appear only as one-line counts ("Ran 2 commands").
 * The home folder in any remaining text is shortened to `~`.
 */
import { latestGeneratedFiles } from "../../shared/generated-files";
import {
  snapshotLanguage,
  snapshotLimits,
  type ShareSnapshot,
  type SnapshotArtifact,
  type SnapshotMessage,
} from "../../shared/sharing";
import type { Conversation, Item, Turn } from "../../shared/types";
import { githubRepositoryName } from "../git/git-branch";
import type { ArtifactShareInput } from "../../shared/types";

/** Why a snapshot cannot be made, in words the Share dialog shows. */
export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly reason: "incognito" | "empty" | "too-large",
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

export const tooLargeMessage = "This chat is too large to share.";

/**
 * Replaces home folders (`/Users/<name>`, `/home/<name>`,
 * `C:\Users\<name>`) with `~`, so a shared text does not name the account
 * on this computer. Addresses such as `https://host/home/x` are left alone.
 */
export function redactHomeFolders(text: string) {
  return text
    .replace(/(?<![\w.~-])\/(?:Users|home)\/[^/\\\s"'`<>()[\]]+/g, "~")
    .replace(/(?<![\w])[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>()[\]]+/gi, "~");
}

/**
 * Files that usually hold secrets (environment files, keys, credentials).
 * A reply may have written one, but its content never goes into a public
 * snapshot; the reply's activity line still counts the edit.
 */
export function secretFileName(name: string) {
  const base = name.toLowerCase();
  return (
    /^\.env(\..*)?$/.test(base) ||
    /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|asc|gpg)$/.test(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base) ||
    [
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      ".htpasswd",
      "credentials",
      "credentials.json",
      "secrets.json",
      "secrets.yml",
      "secrets.yaml",
      "service-account.json",
    ].includes(base)
  );
}

/** "" for none, `one` for one, `many` with `#` as the count otherwise. */
const counted = (count: number, one: string, many: string) =>
  count === 0 ? "" : count === 1 ? one : many.replace("#", String(count));

/** One line per kind of tool the reply used; never what it ran or read. */
export function activitySummary(items: Item[]): string[] {
  let commands = 0,
    searches = 0,
    tools = 0,
    agents = 0;
  const files = new Set<string>();
  for (const item of items)
    switch (item.type) {
      case "commandExecution":
        commands++;
        break;
      case "fileChange":
        for (const change of item.changes ?? []) files.add(change.path);
        break;
      case "webSearch":
        searches++;
        break;
      case "mcpToolCall":
      case "dynamicToolCall":
        tools++;
        break;
      case "collabAgentToolCall":
        agents++;
        break;
    }
  return [
    counted(commands, "Ran a command", "Ran # commands"),
    counted(files.size, "Edited a file", "Edited # files"),
    counted(searches, "Searched the web", "Searched the web # times"),
    counted(tools, "Used a tool", "Used # tools"),
    counted(agents, "Ran an agent", "Ran # agents"),
  ].filter(Boolean);
}

/** The reply's own words: its agent messages, in order. */
function replyText(turn: Turn) {
  return turn.items
    .filter((item) => item.type === "agentMessage" && item.text?.trim())
    .map((item) => item.text!.trim())
    .join("\n\n");
}

export interface SnapshotOptions {
  /** Largest artifact the service takes; larger files are left out. */
  maxArtifactBytes: number;
  /** Largest snapshot the service takes. */
  maxSnapshotBytes: number;
}

/** The size the service measures: the snapshot as JSON, in UTF-8 bytes. */
export function snapshotBytes(snapshot: ShareSnapshot) {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

/**
 * The snapshot of a conversation's current branch. Turns still running are
 * left out; text files the replies wrote become artifacts (binary files and
 * files over the artifact limit stay out). Throws a SnapshotError when the
 * conversation may not or cannot be shared.
 */
export function buildConversationSnapshot(
  conversation: Conversation,
  options: SnapshotOptions,
): ShareSnapshot {
  if (conversation.incognito)
    throw new SnapshotError("Incognito chats can't be shared.", "incognito");
  const turns = conversation.turns.filter(
    (turn) => turn.status !== "inProgress",
  );
  // Each file once, at its latest version, shown under the reply that wrote it last.
  const files = [...latestGeneratedFiles(turns).values()].filter(
    (file) =>
      file.state === "ready" &&
      !file.blob &&
      !secretFileName(file.name) &&
      typeof file.content === "string" &&
      Buffer.byteLength(file.content, "utf8") <= options.maxArtifactBytes,
  );
  const writtenBy = new Map<string, string>();
  for (const turn of turns)
    for (const item of turn.items)
      for (const file of item.generatedFiles ?? [])
        writtenBy.set(file.path, turn.id);
  const artifacts: SnapshotArtifact[] = [];
  const artifactOf = new Map<string, number>();
  const messages: SnapshotMessage[] = [];
  for (const turn of turns) {
    const prompt = redactHomeFolders(turn.prompt.trim());
    if (prompt) {
      if (prompt.length > snapshotLimits.userText)
        throw new SnapshotError(tooLargeMessage, "too-large");
      messages.push({ role: "user", text: prompt });
    }
    const text = redactHomeFolders(replyText(turn));
    const activity = activitySummary(turn.items);
    const written: number[] = [];
    for (const file of files) {
      if (writtenBy.get(file.path) !== turn.id || artifactOf.has(file.path))
        continue;
      if (artifacts.length >= snapshotLimits.artifacts) break;
      artifactOf.set(file.path, artifacts.length);
      written.push(artifacts.length);
      artifacts.push({
        title: redactHomeFolders(file.name).slice(0, snapshotLimits.title),
        ...snapshotLanguage(file.language),
        content: redactHomeFolders(file.content!),
      });
    }
    if (!text && !activity.length && !written.length) continue;
    if (text.length > snapshotLimits.assistantText)
      throw new SnapshotError(tooLargeMessage, "too-large");
    messages.push({
      role: "assistant",
      text,
      ...(activity.length ? { activity } : {}),
      ...(written.length ? { artifacts: written } : {}),
    });
  }
  if (!messages.length)
    throw new SnapshotError(
      "There's nothing in this chat to share yet.",
      "empty",
    );
  if (messages.length > snapshotLimits.messages)
    throw new SnapshotError(tooLargeMessage, "too-large");
  const repositories =
    conversation.mode === "code"
      ? [
          ...new Set([
            ...(conversation.repository
              ? [conversation.repository.fullName]
              : []),
            ...(conversation.sessionRepositories ?? []).flatMap(
              (repository) => {
                const name = githubRepositoryName(repository.url);
                return name ? [name] : [];
              },
            ),
          ]),
        ]
      : [];
  const snapshot: ShareSnapshot = {
    kind: "conversation",
    ...(repositories.length ? { repositories } : {}),
    ...(conversation.sessionAuthors
      ? { sessionAuthors: conversation.sessionAuthors }
      : {}),
    title: shareTitle(conversation.title, "Untitled chat"),
    mode: conversation.mode,
    messages,
    ...(artifacts.length ? { artifacts } : {}),
  };
  if (snapshotBytes(snapshot) > options.maxSnapshotBytes)
    throw new SnapshotError(tooLargeMessage, "too-large");
  return snapshot;
}

/** A title the service takes: trimmed, home folders shortened, at most 200 characters. */
export function shareTitle(title: string, fallback: string) {
  return (
    redactHomeFolders(title.replace(/\s+/g, " ").trim()).slice(
      0,
      snapshotLimits.title,
    ) || fallback
  );
}

/**
 * The snapshot of one artifact (Publish, Anyone with the link). The content
 * is published exactly as shown: an artifact is the person's chosen work,
 * so it is not rewritten; only its title is shortened like a chat's.
 */
export function buildArtifactSnapshot(
  input: ArtifactShareInput,
  options: SnapshotOptions,
): ShareSnapshot {
  if (Buffer.byteLength(input.content, "utf8") > options.maxArtifactBytes)
    throw new SnapshotError(
      "This artifact is too large to share.",
      "too-large",
    );
  const title = shareTitle(input.title, "Untitled artifact");
  const snapshot: ShareSnapshot = {
    kind: "artifact",
    title,
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
    artifacts: [
      { title, ...snapshotLanguage(input.language), content: input.content },
    ],
  };
  if (snapshotBytes(snapshot) > options.maxSnapshotBytes)
    throw new SnapshotError(
      "This artifact is too large to share.",
      "too-large",
    );
  return snapshot;
}

/** The id of the last turn a snapshot includes, to tell when a share is behind. */
export function lastSharedTurn(conversation: Conversation) {
  for (let index = conversation.turns.length - 1; index >= 0; index--)
    if (conversation.turns[index].status !== "inProgress")
      return conversation.turns[index].id;
  return undefined;
}
