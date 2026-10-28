import type { CodeSlashCommand } from "./code/code-slash-commands";
import { loopCommand } from "../../shared/session-loops";
import { codeSlashCommands } from "./code/code-slash-commands";
import {
  resolveCodeSlashArgument,
  executeCodeSlashCommand,
} from "./code/code-slash-actions";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { fastModeState } from "./code/code-fast-mode";
import { useEffect, useRef } from "react";
import { outputStyleNames } from "../../shared/output-styles";
import { requestCodeFeedback } from "../code-feedback/feedback-request";
import type {
  Attachment,
  Conversation,
  Mode,
  Settings,
} from "../../shared/types";
import type { ComposerField } from "./composer-field";
import type { PendingAttachment } from "./Attachments";
import type { VoicePhase } from "../voice/useVoiceMode";
import type { AppController } from "../app/AppContext";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { CustomSlashCommand } from "../../shared/composer-api";
import type { ClientPolicy } from "../../shared/client-policy";
import { useComposerAttachments } from "./useComposerAttachments";
import { formatText, t } from "../i18n";

/** What useComposerActions needs from Composer.tsx. */
export interface UseComposerActionsKit {
  active: Conversation | undefined;
  appContext: AppController | undefined;
  attachments: Attachment[];
  attachmentsAllowed: boolean;
  bash: boolean;
  catalog: ModelCatalog | null;
  codeHomeDraft: boolean;
  composer: React.RefObject<ComposerField | null>;
  customSlash: (name: string) => CustomSlashCommand | undefined;
  cwd: string | undefined;
  draftIdentity: string;
  mode: Mode;
  model: string;
  narrow: boolean;
  notify: (message: string) => void;
  onCompact: () => void;
  onExportSession: (() => void) | undefined;
  onFork: ((prompt: string) => void) | undefined;
  onGoal: ((goal: string) => void) | undefined;
  onHandOff: (() => void) | undefined;
  onHelp: (() => void) | undefined;
  onNavigate: (page: string) => void;
  onOpenTasks: (() => void) | undefined;
  onOpenUsage: () => void;
  onRenameSession: ((title: string) => void) | undefined;
  onReview: ((args: string) => void) | undefined;
  onRewind: (() => void) | undefined;
  onSideChat: ((question: string) => void) | undefined;
  onStatus: (() => void) | undefined;
  onToggleDiff: (() => void) | undefined;
  openSettingsTab: (tab: string) => void;
  pending: PendingAttachment[];
  pendingSlash: string | null;
  pickFiles: () => Promise<void>;
  platform: NodeJS.Platform;
  policy: ClientPolicy;
  providerId: string;
  report: (error: unknown) => void;
  runCustomSlash: (command: CodeSlashCommand, args: string) => Promise<void>;
  running: boolean;
  selectModel: (id: string, name: string) => void;
  setAddMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setEffortOpenRequest: React.Dispatch<React.SetStateAction<number>>;
  setLinearIssuesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setModel: (name: string) => void;
  setModelMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setPending: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  setPendingSlash: React.Dispatch<React.SetStateAction<string | null>>;
  setPermissionOpenRequest: React.Dispatch<React.SetStateAction<number>>;
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashPlaceholderGone: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashTokenSelected: React.Dispatch<React.SetStateAction<boolean>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  settings: Settings;
  text: string;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  updateRequired: boolean;
  voicePhase: VoicePhase;
}

export function useComposerActions(kit: UseComposerActionsKit) {
  const {
    active,
    appContext,
    attachments,
    attachmentsAllowed,
    bash,
    catalog,
    codeHomeDraft,
    composer,
    customSlash,
    cwd,
    draftIdentity,
    mode,
    model,
    narrow,
    notify,
    onCompact,
    onExportSession,
    onFork,
    onGoal,
    onHandOff,
    onHelp,
    onNavigate,
    onOpenTasks,
    onOpenUsage,
    onRenameSession,
    onReview,
    onRewind,
    onSideChat,
    onStatus,
    onToggleDiff,
    openSettingsTab,
    pending,
    pendingSlash,
    pickFiles,
    platform,
    policy,
    providerId,
    report,
    runCustomSlash,
    running,
    selectModel,
    setAddMenu,
    setAttachments,
    setEffortOpenRequest,
    setLinearIssuesOpen,
    setModel,
    setModelMenu,
    setPending,
    setPendingSlash,
    setPermissionOpenRequest,
    setSlashDismissed,
    setSlashPlaceholderGone,
    setSlashTokenSelected,
    setText,
    settings,
    text,
    updatePreference,
    updateRequired,
    voicePhase,
  } = kit;
  const chooseSlash = (command: CodeSlashCommand) => {
    setSlashDismissed(true);
    setPendingSlash(command.name);
    setText("");
    composer.current?.focus();
  };
  const createLoop = (args: string) => {
    if (!active) return;
    try {
      const input = loopCommand(args);
      void window.desktop
        .createSessionLoop(active.id, input)
        .then(() => {
          setText("");
          onOpenTasks?.();
        })
        .catch(report);
    } catch (error) {
      report(error);
    }
  };
  /** /copy [N]: the latest reply's text, or the Nth latest's, on the clipboard. */
  const copyReply = (args: string) => {
    if (running) {
      notify(
        t("Claudex is still replying. Send /copy when the reply is done."),
      );
      return;
    }
    const wanted = Number.parseInt(args.trim(), 10);
    const replies = (active?.turns ?? [])
      .map((turn) =>
        turn.items
          .filter((item) => item.type === "agentMessage")
          .map((item) => item.text ?? "")
          .join("\n\n")
          .trim(),
      )
      .filter(Boolean);
    const reply = replies.at(-(wanted >= 1 ? wanted : 1));
    if (!reply) {
      notify(t("There’s no reply to copy yet."));
      return;
    }
    void window.desktop.copyText(reply).then(
      () => notify(t("Reply copied to clipboard.")),
      () => notify(t("Couldn’t copy the reply to the clipboard. Try again.")),
    );
  };
  const runPendingSlash = () => {
    if (!pendingSlash) return;
    const command =
      codeSlashCommands.find((item) => item.name === pendingSlash) ??
      customSlash(pendingSlash);
    const args = text;
    if (!command) {
      setPendingSlash(null);
      return;
    }
    const result = resolveCodeSlashArgument(
      command.name,
      text,
      settings.providers,
      providerId,
    );
    if (result.kind === "error") {
      notify(result.message);
      return;
    }
    setPendingSlash(null);
    setText("");
    if (result.kind === "model") {
      selectModel(result.providerId, result.model);
      return;
    }
    if (result.kind === "effort") {
      void updatePreference({ codeEffort: result.value });
      return;
    }
    if (result.kind === "autocompact") {
      void updatePreference({ codeAutoCompactTokens: result.tokens });
      notify(
        result.tokens
          ? formatText("Auto-compact set to {tokens} tokens", {
              tokens: result.tokens.toLocaleString("en-US"),
            })
          : "Auto-compact follows the model’s own limit",
      );
      return;
    }
    if (result.kind === "theme") {
      void updatePreference({ theme: result.value });
      notify(
        formatText("Appearance set to {theme}", {
          theme: t(
            { light: "Light", dark: "Dark", system: "System" }[result.value],
          ),
        }),
      );
      return;
    }
    // `/schedule <description>`: the Routines page asks to confirm (R13-D).
    if (command.name === "schedule" && text.trim())
      requestScheduleConfirmation({
        description: text.trim(),
        cwd: active?.cwd ?? cwd,
        providerId,
        model,
      });
    executeCodeSlashCommand(
      command,
      {
        platform,
        inWorktree: Boolean(active?.worktree),
        navigate: onNavigate,
        settings: openSettingsTab,
        model: () => {
          if (codeHomeDraft) setEffortOpenRequest(0);
          setModelMenu(true);
        },
        effort: () => {
          if (codeHomeDraft) setModelMenu(true);
          setEffortOpenRequest((value) => value + 1);
        },
        fast: () => {
          const state = fastModeState(catalog, model);
          if (state.available) setModel(state.target);
          else notify(formatText("Fast mode: {x}.", { x: t(state.reason) }));
        },
        permissions: () => {
          if (codeHomeDraft) setEffortOpenRequest(0);
          setModelMenu(false);
          setPermissionOpenRequest((value) => value + 1);
        },
        plan: (patch) => {
          void updatePreference(patch).catch(report);
        },
        usage: onOpenUsage,
        status: onStatus && active ? onStatus : undefined,
        rename: onRenameSession && active ? onRenameSession : undefined,
        goal: onGoal && active ? onGoal : undefined,
        exportSession: onExportSession && active ? onExportSession : undefined,
        diff: onToggleDiff && active ? onToggleDiff : undefined,
        outputStyle:
          appContext && active
            ? (name) => {
                const names = outputStyleNames(active.customOutputStyles);
                const found = names.find(
                  (style) => style.toLowerCase() === name.toLowerCase(),
                );
                if (!name)
                  notify(
                    formatText("Output styles: {styles}", {
                      styles: names.join(", "),
                    }),
                  );
                else if (!found)
                  notify(
                    formatText("Unknown output style: {style}", {
                      style: name,
                    }),
                  );
                else
                  void appContext
                    .patchConversation(active, { outputStyle: found })
                    .catch(report);
              }
            : undefined,
        feedback: active ? requestCodeFeedback : undefined,
        help: onHelp,
        copy: copyReply,
        tasks: onOpenTasks,
        loop: active ? createLoop : undefined,
        compact: onCompact,
        fork: onFork && active ? () => onFork(text.trim()) : undefined,
        handOff: onHandOff && active ? onHandOff : undefined,
        rewind: onRewind && active ? onRewind : undefined,
        review: onReview && active ? () => onReview(args) : undefined,
        btw: onSideChat ? () => onSideChat(args) : undefined,
        custom: (custom) => void runCustomSlash(custom, args).catch(report),
        unavailable: notify,
      },
      args,
    );
  };
  useEffect(() => setPendingSlash(null), [draftIdentity, mode]);
  useEffect(() => {
    setSlashPlaceholderGone(false);
    setSlashTokenSelected(false);
  }, [pendingSlash]);
  useEffect(() => {
    setPending([]);
    setLinearIssuesOpen(false);
  }, [draftIdentity]);
  // The draft a pasted or dropped file was added to; one that finishes after
  // the person moved to another draft is not attached there.
  const currentDraft = useRef(draftIdentity);
  currentDraft.current = draftIdentity;
  const {
    chooseFiles,
    openSkillsSettings,
    dropScope,
    dropState,
    frame,
    onPaste,
    runAttachJobs,
  } = useComposerAttachments({
    appContext,
    attachments,
    attachmentsAllowed,
    bash,
    catalog,
    codeHomeDraft,
    composer,
    currentDraft,
    draftIdentity,
    mode,
    model,
    narrow,
    notify,
    openSettingsTab,
    pending,
    pickFiles,
    platform,
    policy,
    report,
    setAddMenu,
    setAttachments,
    setEffortOpenRequest,
    setModel,
    setModelMenu,
    setPending,
    setPermissionOpenRequest,
    updateRequired,
    voicePhase,
  });
  return {
    currentDraft,
    createLoop,
    chooseFiles,
    openSkillsSettings,
    runPendingSlash,
    chooseSlash,
    dropScope,
    dropState,
    frame,
    onPaste,
    runAttachJobs,
  } as const;
}
