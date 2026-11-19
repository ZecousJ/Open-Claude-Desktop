/**
 * claudex:// links (desktop 2.37337.1: claude://claude.ai/new?q=…,
 * claude.ai/chat/{id}, claude.ai/project/{id}, code/new, code/continue,
 * code/needs-input, cowork/new?q=…): what each opens. The host may also be
 * left out or be Claudex's own site, so claudex://new and
 * claudex://claudex.zecous.cn/new are the same link. Settings links stay
 * with shared/connector-links.ts.
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
  | { kind: "code-continue"; id: string }
  | { kind: "project"; id: string }
  /** The sessions waiting for an answer: one of them, or the window. */
  | { kind: "needs-input"; id?: string };

/** Longest prompt a link fills in (as the web's /new?q=). */
export const deepLinkPromptLimit = 10_000;
const siteHosts = new Set(["claudex.zecous.cn", "claude.ai"]);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

// (desktop 2.37337.1, index.chunk-BWk6pVUt.js, _Yn / vYn)
export function codeEntryConversation(
  link: Extract<
    DeepLink,
    { kind: "conversation" | "code-continue" | "needs-input" }
  >,
  conversations: readonly Conversation[],
  waiting: ReadonlySet<string>,
) {
  const visible = conversations.filter(
    (conversation) => !conversation.archived && !conversation.incognito,
  );
  const matches = (conversation: Conversation) =>
    conversation.id === link.id || `local_${conversation.id}` === link.id;
  if (link.kind !== "needs-input")
    return link.id === "last"
      ? visible
          .filter((conversation) => conversation.mode === "code")
          .sort((first, second) => second.updatedAt - first.updatedAt)[0]
      : visible.find(
          (conversation) =>
            conversation.mode === "code" && matches(conversation),
        );
  const pending = visible
    .filter(
      (conversation) =>
        (conversation.mode === "code" || conversation.mode === "cowork") &&
        waiting.has(conversation.id),
    )
    .sort((first, second) => first.updatedAt - second.updatedAt);
  return pending.find(matches) ?? pending[0];
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
  if (siteHosts.has(parts[0] ?? "")) parts.shift();
  const query = url.searchParams;
  const prompt =
    (
      query.get("q") ?? (parts[0] === "code" ? query.get("prompt") : null)
    )?.slice(0, deepLinkPromptLimit) || undefined;
  const id = (value: string | null | undefined) =>
    value && idPattern.test(value) ? value : undefined;
  const [first, second] = parts;
  if (parts.length === 1 && first === "new")
    return {
      kind: "new",
      mode: query.get("surface") === "cowork" ? "cowork" : "chat",
      ...(prompt ? { prompt } : {}),
    };
  if (first === "chat" && second === "new")
    return { kind: "new", mode: "chat", ...(prompt ? { prompt } : {}) };
  if (first === "cowork" && second === "new")
    return { kind: "new", mode: "cowork", ...(prompt ? { prompt } : {}) };
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
      return session ? { kind: "code-continue", id: session } : undefined;
    }
    if (second === "needs-input") {
      const session = id(query.get("session"));
      return { kind: "needs-input", ...(session ? { id: session } : {}) };
    }
  }
  return undefined;
}
