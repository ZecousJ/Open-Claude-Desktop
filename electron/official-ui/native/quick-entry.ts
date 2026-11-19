import type { BrowserWindow } from "electron";
import { z } from "zod";
import type { NativeHost } from "./host";

export interface OfficialQuickEntrySubmission {
  text: string;
  images: { base64: string; mimeType: string; filename?: string }[];
  chatId?: string;
}

const recentChats = z.array(
  z.object({
    chatId: z.string(),
    chatName: z.string(),
  }),
);
const chatId = z.string().nullable();

export function registerQuickEntry(host: NativeHost) {
  const documents = new WeakMap<
    BrowserWindow,
    {
      ready: boolean;
      pending: (OfficialQuickEntrySubmission | "new-chat")[];
      route?: string;
      recents?: {
        chats: z.infer<typeof recentChats>;
        activeChatId: string | null;
      };
    }
  >();
  function send(
    window: BrowserWindow,
    submission: OfficialQuickEntrySubmission | "new-chat",
  ) {
    if (submission === "new-chat")
      window.webContents.send("cmdK", { keyPress: false });
    else host.emitTo(window, "QuickEntry", "onQuickEntrySubmit", submission);
  }

  host.on("OsOpenHandlers.ready", () => {
    const window = host.caller;
    const document = window && documents.get(window);
    if (!window || !document) return;
    document.ready = true;
    for (const submission of document.pending.splice(0))
      send(window, submission);
    if (document.route) {
      host.emitTo(window, "Navigation", "navigate", document.route);
      document.route = undefined;
    }
  });
  host.on(
    "QuickEntry.setRecentChats",
    (chats: unknown, activeChatId: unknown) => {
      const window = host.caller;
      const document = window && documents.get(window);
      if (!document) return;
      document.recents = {
        chats: recentChats.parse(chats),
        activeChatId: chatId.parse(activeChatId),
      };
    },
  );
  return {
    attach(window: BrowserWindow) {
      const reset = () =>
        documents.set(window, {
          ready: false,
          pending: [],
          route: documents.get(window)?.route,
        });
      reset();
      window.webContents.on("did-start-navigation", (event) => {
        if (event.isMainFrame && !event.isSameDocument) reset();
      });
      window.webContents.on("render-process-gone", reset);
      window.once("closed", () => documents.delete(window));
    },
    recents(window: BrowserWindow) {
      return documents.get(window)?.recents;
    },
    navigate(window: BrowserWindow, route: string) {
      const document = documents.get(window);
      if (!document) return;
      if (document.ready) host.emitTo(window, "Navigation", "navigate", route);
      else document.route = route;
    },
    submit(
      window: BrowserWindow,
      submission: OfficialQuickEntrySubmission | "new-chat",
    ) {
      const document = documents.get(window);
      if (!document) return;
      if (document.ready) send(window, submission);
      else document.pending.push(submission);
    },
  };
}
