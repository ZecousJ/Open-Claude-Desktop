import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { quickPrompt } from "../../shared/quick-entry";
import type { OfficialQuickEntrySubmission } from "../official-ui/native/quick-entry";

type NativeDictationMode = "caps-lock" | "custom";
type RecentChat = { chatId: string; chatName: string };
interface QuickAccessAddon {
  setLogDirectory(directory: string): void;
  events: {
    setListener(callback: (name: string, payload: unknown) => void): void;
  };
  api: {
    setCredentials(baseURL: string, cookie: string, org: string): Promise<void>;
  };
  desktop: {
    setQuickEntrySharing(screenshots: boolean, files: boolean): Promise<void>;
  };
  quickAccess: {
    overlay: {
      toggle(): void;
      setLoggedIn(loggedIn: boolean): void;
      setRecentChats(chats: RecentChat[]): void;
      setActiveChatId(chatId: string | null): void;
    };
    dictation: {
      show(mode: NativeDictationMode): void;
      toggle(mode: NativeDictationMode): void;
      stop(): void;
      setLanguage(language: string): void;
      setAwaitFinalTranscript(enabled: boolean): void;
    };
  };
}

const nativeSubmission = z.object({
  prompt: z.string(),
  images: z.array(z.string()),
  chatId: z.string().nullish(),
});

const addonPath = (root: string) => path.join(root, "quick-access.node");
const unusableAddons = new Set<string>();

export function officialNativeQuickAccessAvailable(root: string) {
  return (
    process.platform === "darwin" &&
    !unusableAddons.has(root) &&
    fs.existsSync(addonPath(root))
  );
}

function nativeLanguage(locale: string) {
  const language = locale.split("-")[0];
  if (language === "en") return locale;
  if (
    locale === "zh-TW" ||
    locale === "zh-HK" ||
    locale === "de-CH" ||
    locale === "nl-BE"
  )
    return locale;
  return language;
}

type Activation = {
  current(): boolean;
  submit(submission: OfficialQuickEntrySubmission): Promise<void>;
};

export function createOfficialNativeQuickAccess(root: string) {
  let addon: QuickAccessAddon;
  try {
    addon = require(addonPath(root));
  } catch (error) {
    unusableAddons.add(root);
    console.error("Native Quick Access could not load:", error);
    return undefined;
  }
  const { overlay, dictation } = addon.quickAccess;
  let activation: Activation | undefined;
  let request = 0;
  let signing: Promise<void> | undefined;
  addon.setLogDirectory(app.getPath("logs"));
  addon.events.setListener((name, payload) => {
    const owner = activation;
    if (name !== "quickEntrySubmitted" || !owner?.current()) return;
    const parsed = nativeSubmission.safeParse(payload);
    if (!parsed.success) return;
    const { prompt, images, chatId } = parsed.data;
    const text = quickPrompt(prompt);
    if (!text && !images.length) return;
    void owner
      .submit({
        text: prompt.trim(),
        images: images.map((base64) => ({ base64, mimeType: "image/jpeg" })),
        ...(chatId ? { chatId } : {}),
      })
      .catch((error: unknown) =>
        console.error("Quick Entry could not submit:", error),
      );
  });
  // The local provider resolves the final text after the microphone stops.
  dictation.setAwaitFinalTranscript(true);
  const sharing = addon.desktop.setQuickEntrySharing(false, false);
  const stop = () => {
    request++;
    dictation.stop();
  };
  return {
    async open(options: {
      owner: Activation;
      chats?: { chats: RecentChat[]; activeChatId: string | null };
      language: string;
      credentials: { baseURL: string; cookie: string } | null;
      organization: string;
      action?: "start" | "toggle";
      mode: NativeDictationMode;
    }) {
      const { credentials, owner, chats, language, action, mode } = options;
      if (action && !credentials) return;
      activation = owner;
      const pending = ++request;
      await sharing;
      if (!owner.current() || pending !== request) return;
      if (credentials) {
        await signing?.catch(() => {});
        if (!owner.current() || pending !== request) return;
        signing = addon.api.setCredentials(
          credentials.baseURL,
          credentials.cookie,
          options.organization,
        );
        await signing;
      }
      if (!owner.current() || pending !== request) return;
      overlay.setLoggedIn(true);
      overlay.setRecentChats(chats?.chats ?? []);
      overlay.setActiveChatId(chats?.activeChatId ?? null);
      dictation.setLanguage(nativeLanguage(language));
      if (action === "start") dictation.show(mode);
      else if (action === "toggle") dictation.toggle(mode);
      else overlay.toggle();
    },
    stop,
    retire() {
      activation = undefined;
      stop();
      overlay.setLoggedIn(false);
      overlay.setRecentChats([]);
      overlay.setActiveChatId(null);
    },
  };
}
