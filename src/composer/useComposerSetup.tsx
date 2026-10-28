import { toggledThinkingEffort } from "../../shared/chat-effort";
import { chatEffortsFor } from "./model/code-model-choices";
import { formatText, t } from "../i18n";
import { api } from "../desktop-api";
import { useEffect, useState } from "react";
import { thinkingShortcut } from "./thinking-shortcut";
import { retiredModel } from "./retired-model";
import { unsupportedModel } from "./unsupported-model";
import { useVoiceAvailability } from "../voice/useVoiceAvailability";
import { updateBlocksSending } from "../../shared/client-release";
import { watchQueuedMessages } from "./queue";
import { useDictationDraft } from "../voice/useDictationDraft";
import { useCodeSlashList } from "./code/useCodeSlashList";
import type { CodeSlashCommand } from "./code/code-slash-commands";
import { skillMessage, expandCustomPrompt } from "./code/code-slash-commands";
import { useReviewComments } from "../changes/review-comments";
import { useComposerMentions } from "./useComposerMentions";
import type { Conversation, Mode, Settings } from "../../shared/types";
import type { ComposerField } from "./composer-field";
import type { AppController } from "../app/AppContext";
import type { CacheChangeKind } from "../../shared/cowork-cache";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { ClientPolicy } from "../../shared/client-policy";

/** What useComposerSetup needs from Composer.tsx. */
export interface UseComposerSetupKit {
  active: Conversation | undefined;
  addMenu: boolean;
  appContext: AppController | undefined;
  bash: boolean;
  cacheChange: {
    confirmChange: (
      kind: CacheChangeKind,
      targetLabel: string,
    ) => Promise<boolean>;
    dialog: React.JSX.Element | undefined;
  };
  caret: number;
  catalog: ModelCatalog | null;
  composer: React.RefObject<ComposerField | null>;
  cwd: string | undefined;
  draftIdentity: string;
  /** A history prompt is recalled or searched: no "/" or "@" panel opens. */
  historyActive: boolean;
  mode: Mode;
  model: string;
  notify: (message: string) => void;
  pendingSlash: string | null;
  platform: NodeJS.Platform;
  policy: ClientPolicy;
  providerId: string;
  report: (error: unknown) => void;
  running: boolean;
  send: (
    options?: { later?: boolean | undefined } | undefined,
  ) => Promise<void>;
  setCaret: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  settings: Settings;
  slashDismissed: boolean;
  slashMatch: RegExpMatchArray | null;
  slashQuery: string;
  slashSelected: number;
  text: string;
  thinkingMode: "standard" | "extended";
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  updatePreferenceDirect: (patch: Partial<Settings>) => Promise<void>;
}

export function useComposerSetup(kit: UseComposerSetupKit) {
  const {
    active,
    addMenu,
    appContext,
    bash,
    cacheChange,
    caret,
    catalog,
    composer,
    cwd,
    draftIdentity,
    historyActive,
    mode,
    model,
    notify,
    pendingSlash,
    platform,
    policy,
    providerId,
    report,
    running,
    send,
    setCaret,
    setText,
    settings,
    slashDismissed,
    slashMatch,
    slashQuery,
    slashSelected,
    text,
    thinkingMode,
    updatePreference,
    updatePreferenceDirect,
  } = kit;
  const nextThinkingEffort = toggledThinkingEffort(
    settings.effort,
    chatEffortsFor(catalog, model),
  );
  const toggleThinking =
    nextThinkingEffort && mode !== "code"
      ? async () => {
          if (mode === "chat") {
            await updatePreference({ effort: nextThinkingEffort });
            return;
          }
          const extended = thinkingMode !== "extended";
          if (
            !(await cacheChange.confirmChange(
              "thinking",
              t(extended ? "Extended thinking" : "Standard"),
            ))
          )
            return;
          const nextMode = extended ? "extended" : "standard";
          if (active) {
            const saved = await api.updateConversation(active.id, {
              thinkingMode: nextMode,
            });
            appContext?.upsert(saved);
          } else {
            await updatePreferenceDirect({ coworkThinkingMode: nextMode });
          }
        }
      : undefined;
  // Capture owns this key in Chat/Cowork; Code retains its effort picker.
  useEffect(() => {
    if (!toggleThinking) return;
    const listener = (event: KeyboardEvent) => {
      if (!thinkingShortcut(event, platform)) return;
      event.preventDefault();
      event.stopPropagation();
      void toggleThinking().catch(report);
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [toggleThinking, platform, report]);
  // A conversation whose model was retired replies with the default; the model
  // button shows it and the menu says so at its head.
  const retired = retiredModel(
    active,
    settings.providers,
    settings.activeProviderId,
    catalog,
  );
  // A session on a computer runs that computer's models, not this list's.
  const unsupported = active?.linkedComputerId
    ? undefined
    : unsupportedModel(settings.providers, providerId, model, catalog);
  const voice = useVoiceAvailability(providerId);
  const planAllowed = policy.permissionModes.includes("plan");
  // A required update the service enforces stops sending (owner decision 7).
  const updateRequired = updateBlocksSending(policy.update);
  const attachmentsAllowed = policy.attachments.types.length > 0;
  // A queued Code message that could not be sent is told as an error.
  useEffect(() => watchQueuedMessages(report), []);
  // Dictation (package C6) writes into the draft while it records.
  const dictation = useDictationDraft(text, setText, draftIdentity, () =>
    composer.current?.focus(),
  );
  const {
    commands: slashCommands,
    placeholder: slashPlaceholder,
    custom: customSlash,
  } = useCodeSlashList({
    query: slashMatch ? slashQuery : null,
    pending: pendingSlash,
    active,
    cwd,
    running,
    planAllowed,
  });
  // A custom command's message, sent once the draft shows it.
  const [autoSend, setAutoSend] = useState<string | null>(null);
  useEffect(() => {
    if (autoSend === null || text !== autoSend || unsupported) return;
    setAutoSend(null);
    void send();
  }, [text, autoSend, Boolean(unsupported)]);
  const runCustomSlash = async (command: CodeSlashCommand, args: string) => {
    let message: string;
    if (command.source === "skill") message = skillMessage(command.name, args);
    else {
      const body = await window.desktop.readCustomPrompt(command.name);
      if (body === null) {
        notify(
          formatText("The prompt /{name} is no longer available.", {
            name: command.name,
          }),
        );
        return;
      }
      message = expandCustomPrompt(body, args);
    }
    if (!message) return;
    setText(message);
    setAutoSend(message);
  };
  // Text after / that matches no command shows no palette (the original has no
  // "No commands found" state), so Enter sends it as typed.
  const slashOpen = Boolean(
    slashMatch && !slashDismissed && !addMenu && slashCommands.length,
  );
  const selectedSlash = Math.min(
    slashSelected,
    Math.max(0, slashCommands.length - 1),
  );
  // Comments on the Changes panel's lines, sent with the next message.
  const reviewNotes = useReviewComments(
    mode === "code" && active ? active.id : undefined,
  );
  const mentions = useComposerMentions({
    mode,
    text,
    setText,
    caret,
    setCaret,
    active,
    cwd,
    draftIdentity,
    suppressed: {
      slash: Boolean(pendingSlash) || historyActive,
      bash,
      addMenu: Boolean(addMenu),
    },
    composer,
  });
  return {
    unsupported,
    mentions,
    attachmentsAllowed,
    customSlash,
    runCustomSlash,
    updateRequired,
    dictation,
    retired,
    reviewNotes,
    toggleThinking,
    voice,
    selectedSlash,
    slashCommands,
    slashOpen,
    slashPlaceholder,
  } as const;
}
