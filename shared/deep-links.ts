/**
 * claudex:// links: what each opens. The host may also be left out or be a
 * Claudex service's host, so claudex://new and
 * claudex://claudex.example.com/new are the same link. Settings links stay with
 * shared/connector-links.ts.
 */
import { parseSshLink, type SshLinkTarget, sshLinkErrors } from "./ssh-links";
import type { Conversation } from "./types";

export type DeepLink =
  | { kind: "ssh"; target: SshLinkTarget }
  | { kind: "ssh-error"; error: keyof typeof sshLinkErrors }
  | {
      kind: "new";
      mode: "chat" | "cowork" | "code";
      /** Filled into the composer, never sent. */
      prompt?: string;
      /** A new Code session in this folder. */
      folder?: string;
    }
  | { kind: "conversation"; id: string }
  | { kind: "project"; id: string }
  /** The sessions waiting for an answer: one of them, or the window. */
  | { kind: "needs-input"; id?: string };

/** Longest prompt a link fills in (as the web's /new?q=). */
export const deepLinkPromptLimit = 10_000;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function codeEntryConversation(
  link: Extract<DeepLink, { kind: "conversation" | "needs-input" }>,
  conversations: readonly Conversation[],
  waiting: ReadonlySet<string>,
) {
  const visible = conversations.filter(
    (conversation) => !conversation.archived && !conversation.incognito,
  );
  if (link.kind === "conversation")
    return link.id === "last"
      ? visible
          .filter((conversation) => conversation.mode === "code")
          .sort((first, second) => second.updatedAt - first.updatedAt)[0]
      : visible.find((conversation) => conversation.id === link.id);
  const pending = visible
    .filter(
      (conversation) =>
        (conversation.mode === "code" || conversation.mode === "cowork") &&
        waiting.has(conversation.id),
    )
    .sort((first, second) => first.updatedAt - second.updatedAt);
  return (
    pending.find((conversation) => conversation.id === link.id) ?? pending[0]
  );
}

export function parseDeepLink(href: string): DeepLink | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "claudex:" || url.username || url.password)
    return undefined;
  let parts: string[];
  try {
    parts = [url.hostname, ...url.pathname.split("/")]
      .map((part) => decodeURIComponent(part))
      .filter(Boolean);
  } catch {
    return undefined;
  }
  // A host (it has a dot; no link path does) names the site: dropped.
  if (parts[0]?.includes(".")) parts.shift();
  const query = url.searchParams;
  const prompt = query.get("q")?.slice(0, deepLinkPromptLimit) || undefined;
  const id = (value: string | null | undefined) =>
    value && idPattern.test(value) ? value : undefined;
  const [first, second] = parts;
  if (parts.length === 1 && first === "new")
    return { kind: "new", mode: "chat", ...(prompt ? { prompt } : {}) };
  if (first === "chat" && second === "new")
    return { kind: "new", mode: "chat", ...(prompt ? { prompt } : {}) };
  if (first === "cowork" && second === "new")
    return { kind: "new", mode: "chat", ...(prompt ? { prompt } : {}) };
  if (first === "cowork" && second === "project" && id(parts[2]))
    return { kind: "project", id: parts[2] };
  if ((first === "chat" || first === "conversation") && id(second))
    return { kind: "conversation", id: second };
  if (first === "project" && id(second)) return { kind: "project", id: second };
  if (first === "code") {
    if (!second || second === "new") {
      const ssh = parseSshLink(query);
      if (ssh)
        return ssh.kind === "ssh" && prompt
          ? { ...ssh, target: { ...ssh.target, prompt } }
          : ssh;
      const folder = query.get("folder");
      return {
        kind: "new",
        mode: "code",
        ...(prompt ? { prompt } : {}),
        ...(folder && folder.length <= 4096 ? { folder } : {}),
      };
    }
    if (second === "continue") {
      const session = id(query.get("session"));
      return session ? { kind: "conversation", id: session } : undefined;
    }
    if (second === "needs-input") {
      const session = id(query.get("session"));
      return { kind: "needs-input", ...(session ? { id: session } : {}) };
    }
  }
  return undefined;
}
