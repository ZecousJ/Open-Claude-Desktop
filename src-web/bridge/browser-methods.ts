/**
 * The bridge calls the page serves itself ("browser" in
 * shared/web-bridge-methods.ts): the clipboard, new tabs, the file picker,
 * downloads and dictation. Where the desktop shows a save dialog, the web
 * downloads the file into the browser's download folder and resolves to its
 * name; where the desktop opens the system browser, the web opens a tab.
 */
import { sessionExport } from "../../shared/session-export";
import {
  validResourceFile,
  maxResourceBytes,
  type McpResourceFile,
} from "../../shared/message-resources";
import { attachmentTypes, type ClientPolicy } from "../../shared/client-policy";
import { attachmentRefusal } from "../../shared/client-policy-rules";
import { downloadPage, linkOpens } from "../../shared/external-links";
import {
  knowledgeExtensions,
  knowledgeFileLimit,
  type ProjectKnowledge,
} from "../../shared/collections-api";
import type { HostedShare } from "../../shared/sharing-api";
import type { Attachment, Conversation } from "../../shared/types";
import { webPaths } from "../../shared/web-protocol";
import { base64ToBytes } from "../../shared/web-wire";
import type { WebDictation } from "./dictation";
import type { WebEnv } from "../../shared/web-client/env";
import {
  apiError,
  bridgeError,
  readJson,
} from "../../shared/web-client/errors";
import type { BridgeState } from "./state";
import type { WebTransport } from "../../shared/web-client/transport";

/** The desktop picker's limit on files chosen at once. */
export const maxPickedFiles = 12;
/** The desktop's limit on an artifact saved as text. */
const maxArtifactChars = 10 * 1024 * 1024;

type Remote = (method: string, args: unknown[]) => Promise<unknown>;

export interface BrowserDeps {
  env: WebEnv;
  transport: WebTransport;
  state: BridgeState;
  dictation: WebDictation;
  call: Remote;
}

/** A file name without folders or characters file systems refuse. */
export function safeFileName(name: string, fallback: string) {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return base || fallback;
}

/**
 * A conversation as Markdown: each prompt and the replies' text. The same
 * document as the desktop's export (electron/data-export.ts
 * `conversationMarkdown`; the test compares them).
 */
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

/** The file name in a Content-Disposition header, when it has one. */
export function dispositionName(header: string | null) {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      /* fall through */
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim();
}

export function createBrowserMethods(deps: BrowserDeps) {
  const { env, transport, state, dictation, call } = deps;

  async function policy(): Promise<ClientPolicy> {
    const cached = state.cachedPolicy;
    if (cached) return cached;
    const fresh = (await call("clientPolicy", [])) as ClientPolicy;
    state.cachedPolicy = fresh;
    return fresh;
  }

  /** Downloads what a Go downloads/ endpoint answers; resolves to the name. */
  async function downloadFrom(path: string, fallback: string) {
    const response = await transport.fetch(path);
    if (!response.ok) throw apiError(response.status, await readJson(response));
    const name = safeFileName(
      dispositionName(response.headers.get("content-disposition")) ?? "",
      fallback,
    );
    env.download(name, await response.blob());
    return name;
  }

  function saveText(name: string, text: string, type: string) {
    env.download(name, new Blob([text], { type }));
    return name;
  }

  const httpLink = (value: unknown) => {
    let url: URL;
    try {
      url = new URL(String(value).slice(0, 4000));
    } catch {
      throw bridgeError("Only HTTP(S) links can be opened.");
    }
    if (!["https:", "http:"].includes(url.protocol))
      throw bridgeError("Only HTTP(S) links can be opened.");
    return url.href;
  };
  const checkLink = (href: string, current: ClientPolicy) => {
    if (!linkOpens(href, current))
      throw bridgeError("Your administrator has turned off external links.");
    return href;
  };
  const updatePage = (current: ClientPolicy) => {
    const page =
      downloadPage(current.update) ??
      (current.links.apps?.startsWith("https://")
        ? current.links.apps
        : undefined);
    if (!page)
      throw bridgeError("Your administrator hasn't published a download page.");
    return page;
  };

  return {
    copyText: (text: string, html?: string) =>
      env.writeClipboard(
        String(text),
        html === undefined ? undefined : String(html),
      ),
    copyImage: (src: string) => env.writeImageClipboard(src),

    // Fonts of a local Claude installation are never served on the web.

    // A browser tab has no window buttons.
    windowAction: async () => {},

    openExternal: async (value: string) => {
      const href = httpLink(value);
      const cached = state.cachedPolicy;
      // With the policy at hand the tab opens during the click itself.
      if (cached) return env.openTab(checkLink(href, cached));
      return env.openTab(policy().then((fresh) => checkLink(href, fresh)));
    },

    openUpdateDownload: async () => {
      const cached = state.cachedPolicy;
      if (cached) return env.openTab(updatePage(cached));
      return env.openTab(policy().then(updatePage));
    },

    openShare: (shareId: string) =>
      env.openTab(
        (async () => {
          const shares = (await call("hostedShares", [])) as HostedShare[];
          const share = shares.find((item) => item.id === shareId);
          if (!share || share.status !== "active")
            throw bridgeError("This link no longer exists.");
          const url = new URL(share.url, env.origin);
          if (url.protocol !== "https:" && url.origin !== env.origin)
            throw bridgeError("Only secure links can be opened.");
          return url.href;
        })(),
      ),

    chooseAttachments: async (): Promise<Attachment[]> => {
      const known = state.cachedPolicy;
      if (known && !known.attachments.types.length)
        throw bridgeError("Your administrator has turned off attachments.");
      // The picker opens now, during the click; the policy is checked again
      // once the files are chosen.
      const accept = (known?.attachments.types ?? attachmentTypes)
        .map((type) => `.${type}`)
        .join(",");
      const files = await env.pickFiles({ accept, multiple: true });
      if (!files.length) return [];
      const current = await policy();
      if (!current.attachments.types.length)
        throw bridgeError("Your administrator has turned off attachments.");
      const chosen = files.slice(0, maxPickedFiles);
      for (const file of chosen) {
        const refusal = attachmentRefusal(file.name, file.size, current);
        if (refusal) throw bridgeError(refusal);
      }
      const attachments: Attachment[] = [];
      for (const file of chosen)
        attachments.push(
          (await call("addAttachmentData", [
            file.name,
            await file.bytes(),
          ])) as Attachment,
        );
      return attachments;
    },

    // Project files (R13-D): the desktop's dialog becomes the page's picker;
    // the runner checks type, encoding and limits again.
    addProjectKnowledge: async (
      projectId: string,
    ): Promise<ProjectKnowledge> => {
      const files = await env.pickFiles({
        accept: knowledgeExtensions.map((type) => `.${type}`).join(","),
        multiple: true,
      });
      if (!files.length)
        return (await call("listProjectKnowledge", [
          projectId,
        ])) as ProjectKnowledge;
      const chosen = files.slice(0, maxPickedFiles);
      for (const file of chosen)
        if (file.size > knowledgeFileLimit)
          throw bridgeError(
            `${file.name} is too large. Project files can be up to 10 MB.`,
          );
      const read = [];
      for (const file of chosen)
        read.push({ name: file.name, data: await file.bytes() });
      return (await call("addProjectKnowledgeFiles", [
        projectId,
        read,
      ])) as ProjectKnowledge;
    },

    exportConversation: async (id: string) => {
      const conversation = state.conversation(String(id));
      if (conversation?.incognito)
        throw Error("Incognito conversations cannot be exported.");
      if (conversation?.mode === "code") {
        const now = Date.now();
        return saveText(
          `session-${safeFileName(conversation.id, "session")}-${now}.json`,
          JSON.stringify(sessionExport(conversation, now), null, 2),
          "application/json",
        );
      }
      // As the desktop names it: the title with path characters replaced.
      const fallback = `${safeFileName(
        (conversation?.title ?? "").replace(/[\\/:*?"<>|]/g, "_"),
        "Conversation",
      )}.md`;
      if (conversation)
        return saveText(
          fallback,
          conversationMarkdown(conversation),
          "text/markdown;charset=utf-8",
        );
      return downloadFrom(
        `${webPaths.downloads}conversations/${encodeURIComponent(String(id))}.md`,
        fallback,
      );
    },

    exportData: () =>
      downloadFrom(
        `${webPaths.downloads}export`,
        `claudex-export-${new Date(env.now()).toISOString().slice(0, 10)}.zip`,
      ),

    saveArtifact: async (name: string, content: string) => {
      const text = String(content ?? "");
      if (text.length > maxArtifactChars) throw bridgeError("too_large");
      return saveText(
        safeFileName(name, "artifact.txt"),
        text,
        "text/plain;charset=utf-8",
      );
    },

    saveArtifactBytes: async (name: string, base64: string) => {
      if (base64.length > 16 * 1024 * 1024)
        throw bridgeError("This artifact is too large to save.");
      const file = safeFileName(name, "document.docx");
      const bytes = base64ToBytes(base64);
      env.download(
        file,
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: file.toLowerCase().endsWith(".pptx")
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      );
      return file;
    },

    saveMcpResourceFile: async (resource: McpResourceFile) => {
      if (!validResourceFile(resource)) throw bridgeError("bad_request");
      const bytes = base64ToBytes(resource.base64);
      if (bytes.byteLength > maxResourceBytes) throw bridgeError("too_large");
      const file = safeFileName(resource.name, "resource");
      env.download(
        file,
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: resource.mimeType,
        }),
      );
      return file;
    },

    exportDocumentPdf: async (title: string, html: string) => {
      if (html.length > maxArtifactChars)
        throw bridgeError("This artifact is too large to save.");
      const { browserDocumentPdf } = await import("./document-print");
      return browserDocumentPdf(title, html);
    },

    saveGeneratedFile: async (digest: string, name: string) => {
      const base64 = (await call("readGeneratedFile", [digest])) as string;
      const bytes = base64ToBytes(String(base64 ?? ""));
      if (bytes.byteLength > 10 * 1024 * 1024) throw bridgeError("too_large");
      const file = safeFileName(name, "download");
      env.download(
        file,
        new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: "application/octet-stream",
        }),
      );
      return file;
    },

    saveResearchReport: async (conversationId: string, turnId: string) => {
      const report = (await call("readResearchReport", [
        conversationId,
        turnId,
      ])) as { title: string; markdown: string };
      saveText(
        `${safeFileName(report.title, "Research report")}.md`,
        report.markdown,
        "text/markdown;charset=utf-8",
      );
      return true;
    },

    // The window records the audio itself (src/voice/microphone.ts), which
    // asks the browser; this only says whether the site is blocked.
    requestMicrophone: async () =>
      (await env.microphonePermission()) !== "denied",
    openMicrophoneSettings: async () => {},
    startDictation: (options?: unknown) => dictation.start(options),
    dictationAudio: (sessionId: string, pcm: Uint8Array) =>
      dictation.audio(sessionId, pcm),
    finishDictation: (sessionId: string) => dictation.finish(sessionId),
    cancelDictation: (sessionId: string) => dictation.cancel(sessionId),
  } satisfies Record<string, (...args: never[]) => Promise<unknown>>;
}
