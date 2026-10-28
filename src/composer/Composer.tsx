import type { ComposerField } from "./composer-field";
import { useUploadQueue } from "./useUploadQueue";
import { preference } from "../../shared/settings-extras";
import { coworkComputerWaiting } from "../../shared/remote-devices";
import { useCacheChange } from "../cowork/useCacheChange";
import { needsCacheConfirmation } from "../../shared/cowork-cache";
import { AppContext } from "../app/AppContext";
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  Attachment,
  Conversation,
  Mode,
  Project,
  Settings,
} from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { chatEffortsFor, modelLabel } from "./model/code-model-choices";
import { cloudCodeUnavailable } from "./code-cloud";
import {
  currentCodeRepository,
  requestRepositoryPicker,
} from "./code-repository";
import { useComposerControls } from "./useComposerControls";
import { composerFrame } from "./ComposerView";
import { useComposerActions } from "./useComposerActions";
import { useComposerSetup } from "./useComposerSetup";
import { useComposerDraft } from "./useComposerDraft";

import { maxAttachmentsFor } from "./attachment-limits";
import { useModelCatalogState } from "./useComposerServices";
import "./composer-core.css";
import { t } from "../i18n";
import { validSkillTokens, type SkillToken } from "./skill-tokens";
import { chatEffortLabels } from "../../shared/chat-effort";
import { lazyPiece } from "../ui/lazy-piece";
// Extras the composer shows on its own, below or beside the box: one that
// fails to load is left out rather than putting "Couldn't load this." in the
// composer's flow, where it would push the box up (the original's
// noFallback pieces).
export const TaskSuggestions = lazyPiece(
  () => import("../code-home/TaskSuggestions"),
  "TaskSuggestions",
  { silent: true },
);
export const CodeOutputIntent = lazyPiece(
  () => import("./CodeOutputIntent"),
  "CodeOutputIntent",
  { silent: true },
);

// Pieces that show on demand, or only on the desktop, load when they do.
export const ModelMenu = lazyPiece(
  () => import("./model/ModelMenu"),
  "ModelMenu",
);
export const RemoteControlNotice = lazyPiece(
  () => import("../remote-control/SessionRemoteControl"),
  "RemoteControlNotice",
  { silent: true },
);
export const CodeModelMenu = lazyPiece(
  () => import("./model/CodeModelMenu"),
  "CodeModelMenu",
);
export const SubmitPill = lazyPiece(() => import("./SubmitPill"), "SubmitPill");

export const VoiceModeButton = lazyPiece(
  () => import("./VoiceModeButton"),
  "VoiceModeButton",
);
export const ComposerAddMenu = lazyPiece(
  () => import("./ComposerAddMenu"),
  "ComposerAddMenu",
);
const ChatGitHubDialog = lazyPiece(
  () => import("./ChatGitHubDialog"),
  "ChatGitHubDialog",
);
export const CodeAddMenu = lazyPiece(
  () => import("./code/CodeAddMenu"),
  "CodeAddMenu",
);
export const WorkspaceBar = lazyPiece(
  () => import("./WorkspaceBar"),
  "WorkspaceBar",
);
export const CloudWorkspaceBar = lazyPiece(
  () => import("./CloudWorkspaceBar"),
  "CloudWorkspaceBar",
);
// The Code home's Next steps load with the home (src/code-home/NextSteps.tsx).
export const NextSteps = lazy(() => import("../code-home/NextSteps"));

/** Only a Code draft with a chosen @ file needs it: loaded then. */
// The drop overlay only matters once something is dragged in, so it loads
// after the first screen.
// The rare "model not offered here" card loads when it is needed.
export const UnsupportedModel = lazyPiece(
  () => import("./UnsupportedModel"),
  "UnsupportedModel",
);
export const ImportIssueDialog = lazyPiece(
  () => import("../github/ImportIssueDialog"),
);
export const ImportLinearIssueDialog = lazyPiece(
  () => import("../linear/ImportLinearIssueDialog"),
);
export const LinearIssuePill = lazyPiece(
  () => import("../linear/LinearIssuePill"),
);
export const DropOverlay = lazyPiece(
  () => import("./DropOverlay"),
  "DropOverlay",
  {
    silent: true,
  },
);
export const MentionMirror = lazyPiece(
  () => import("./MentionMirror"),
  "MentionMirror",
  { silent: true },
);
export const SkillTokenMirror = lazyPiece(
  () => import("./SkillTokenMirror"),
  "SkillTokenMirror",
  { silent: true },
);

/** What Bash mode says to a file, folder or card. */
export const bashRefusal =
  "Bash mode is on, so nothing was added. Press Backspace in the empty message box to return to chat, then try again.";
export const BashModePill = lazyPiece(
  () => import("./BashModePill"),
  "BashModePill",
);
/**
 * The first composer of the window's life: its actions fade in over 240ms
 * as they replace the boot shell's empty toolbar (the original's static
 * composer boot fade).
 */
let composerBooted = false;

type ComposerProps = {
  /** Incognito chat: no Chat/Cowork switch. */
  incognito?: boolean;
  skillTokens?: SkillToken[];
  setSkillTokens?: (tokens: SkillToken[]) => void;
  settings: Settings;
  platform: NodeJS.Platform;
  active?: Conversation;
  activeId?: string;
  project?: Project;
  projectOverview?: boolean;
  projects: Project[];
  /** The open artifact, if any. Kept for callers; the row under the frame
   * shows the disclaimer's first sentence beside an artifact as everywhere
   * else now. */
  artifact?: Artifact;
  /** A side panel narrows the conversation column (the notices' narrow frame). */
  narrow?: boolean;
  mode: Mode;
  /** The chosen project; null takes the conversation out of its project. */
  onProject: (id: string | null) => void;
  /** With a name, creates a project of that name and selects it. */
  onCreateProject: (name?: string) => void;
  /** Home picker: opens the project editor with an optional initial name. */
  onNewProject?: (name?: string) => void;
  openSettingsTab: (tab: string) => void;
  onNavigate: (page: string) => void;
  onOpenUsage: () => void;
  /** /status: the open session's Session info card. */
  onStatus?: () => void;
  /** No Code session yet: the first-run placeholder. */
  firstRun?: boolean;
  /** /rename, /export, /diff and /help for the open session. */
  onRenameSession?: (title: string) => void;
  onGoal?: (goal: string) => void;
  onExportSession?: () => void;
  onToggleDiff?: () => void;
  onHelp?: () => void;
  /** /tasks and /workflows: the session's background tasks (workflows among them). */
  onOpenTasks?: () => void;
  /** /compact: summarizes the open conversation (thread/compact/start). */
  onCompact: () => void;
  /** /fork [prompt]: forks the open conversation, sending the prompt there. */
  onFork?: (prompt: string) => void;
  /** /handoff and the context ring: a new session starting from a note about this one. */
  onHandOff?: () => void;
  /** /rewind: steps back to before the last message. */
  onRewind?: () => void;
  /** /review: Codex reviews the open session; the text after it says what. */
  onReview?: (args: string) => void;
  /** /btw [question]: opens the side chat, asking the question there when given. */
  onSideChat?: (question: string) => void;
  webSearch: boolean;
  webSearchAvailable: boolean;
  onWebSearch: () => void;
  /** Research mode; left out where Research isn't offered. */
  research?: boolean;
  researchAvailable?: boolean;
  researchUnavailableReason?: string;
  onResearch?: () => void;
  draftIdentity: string;
  setMode: (mode: Mode) => void;
  providerId: string;
  setProviderId: (id: string) => void;
  model: string;
  setModel: (model: string) => void;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  cwd?: string;
  setCwd: (cwd?: string) => void;
  /** Code folders offered by the folder chip, most recent first. */
  recentFolders: string[];
  running: boolean;
  sending: boolean;
  composer: RefObject<ComposerField | null>;
  pickFiles: () => Promise<void>;
  pickFolder: () => Promise<void>;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  onCodePermissionChange?: (
    patch: import("../../shared/code-session-permissions").CodePermissionPatch,
  ) => Promise<void>;
  /** `later`: queue the message for after the running turn (⌘↵) instead of steering it. */
  send: (options?: { later?: boolean }) => Promise<void>;
  /**
   * Bash mode: runs a line as a shell command in the open Code session;
   * false when it did not start. Left out where sessions can't run one.
   */
  onShell?: (command: string) => Promise<boolean>;
  interrupt: () => Promise<void>;
  report: (error: unknown) => void;
  notify: (message: string) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Pending approvals docked above the composer. */
  dock?: ReactNode;
  /** The Code session's branch row, between the dock and the composer. */
  branchRow?: ReactNode;
  /**
   * The conversation's queued messages (Code: QueuedMessageBar; Chat and
   * Cowork: ChatComposerQueuedMessages), between the dock and the branch row as
   * the reference design orders them.
   */
  queuedBar?: ReactNode;
};
/** Return-key glyph drawn on a 0.5px grid to match Claude's Code composer send hint. */
export function CodeReturnIcon({ width = 11 }: { width?: number }) {
  return (
    <svg
      className="code-return-icon"
      width={width}
      height={(width * 10) / 11}
      viewBox="0 0 22 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.5 2H17.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H1.5" />
      <path d="M6.5 7.5 1.5 13l5 5.5" />
    </svg>
  );
}
export function Composer({
  settings,
  platform,
  active,
  activeId,
  project,
  projectOverview = false,
  projects,
  narrow = false,
  onProject,
  onCreateProject,
  onNewProject,
  openSettingsTab,
  onNavigate,
  onOpenUsage,
  onStatus,
  firstRun = false,
  onRenameSession,
  onGoal,
  onExportSession,
  onToggleDiff,
  onHelp,
  onOpenTasks,
  onCompact,
  onFork,
  onHandOff,
  onRewind,
  onReview,
  onSideChat,
  webSearch,
  webSearchAvailable,
  onWebSearch,
  research = false,
  researchAvailable = false,
  researchUnavailableReason,
  onResearch,
  draftIdentity,
  mode,
  setMode,
  providerId,
  setProviderId,
  model,
  setModel: setModelDirect,
  text,
  setText,
  skillTokens = [],
  setSkillTokens,
  attachments,
  setAttachments,
  cwd,
  setCwd,
  recentFolders,
  running,
  sending,
  composer,
  pickFiles,
  pickFolder,
  updatePreference: updatePreferenceDirect,
  onCodePermissionChange,
  send,
  onShell,
  interrupt,
  report,
  notify,
  setSettingsOpen,
  incognito = false,
  dock,
  branchRow,
  queuedBar,
}: ComposerProps) {
  const appContext = useContext(AppContext);
  const cacheChange = useCacheChange(mode, active);
  const thinkingMode =
    active?.thinkingMode ?? preference(settings, "coworkThinkingMode");
  const selectModel = (id: string, name: string) => {
    if (id === providerId && name === model) return;
    const apply = () => {
      setProviderId(id);
      setModelDirect(name);
    };
    if (!needsCacheConfirmation(mode, active)) apply();
    else
      void cacheChange
        .confirmChange("model", modelLabel(catalog, name))
        .then((confirmed) => {
          if (confirmed) apply();
        });
  };
  const setModel = (name: string) => {
    selectModel(providerId, name);
  };
  const updatePreference: ComposerProps["updatePreference"] = async (patch) => {
    if (
      mode === "code" &&
      onCodePermissionChange &&
      ("codeSandbox" in patch ||
        "codePlanMode" in patch ||
        "autoAcceptEdits" in patch)
    ) {
      try {
        await onCodePermissionChange({ ...settings, ...patch });
      } catch (error) {
        if (!(
          error instanceof Error && error.name === "CodePermissionCanceled"
        ))
          throw error;
      }
      return;
    }
    if (
      patch.effort &&
      patch.effort !== settings.effort &&
      !(await cacheChange.confirmChange(
        "effort",
        t(chatEffortLabels[patch.effort]),
      ))
    )
      return;
    await updatePreferenceDirect(patch);
  };
  const catalogRead = useModelCatalogState();
  const catalog = catalogRead.value ?? null;
  const extendedThinking =
    mode === "cowork" ? thinkingMode === "extended" : settings.effort !== "low";
  const thinkingEfforts = chatEffortsFor(catalog, model);
  const thinkingAvailable =
    mode === "cowork" ||
    (thinkingEfforts.includes("low") && thinkingEfforts.length > 1);
  const [boot, setBoot] = useState(() => {
    const first = !composerBooted;
    composerBooted = true;
    return first;
  });
  useEffect(() => {
    if (!boot) return;
    const timer = setTimeout(() => setBoot(false), 300);
    return () => clearTimeout(timer);
  }, [boot]);
  const {
    setBashMode,
    history,
    historyActive,
    voicePhase,
    bash,
    cloudCodeMissing,
    cloudHome,
    setModelMenu,
    addMenu,
    caret,
    pendingSlash,
    policy,
    setCaret,
    slashDismissed,
    slashMatch,
    slashQuery,
    slashSelected,
    codeHomeDraft,
    pending,
    setAddMenu,
    setEffortOpenRequest,
    setLinearIssuesOpen,
    setPending,
    setPendingSlash,
    setPermissionOpenRequest,
    setSlashDismissed,
    setSlashPlaceholderGone,
    setSlashTokenSelected,
    dictationPhase,
    dictationTarget,
    effortOpenRequest,
    forkSendAvailable,
    host,
    inCloud,
    incognitoControls,
    modelMenu,
    openModelService,
    permissionOpenRequest,
    setDictationPhase,
    setGithubOpen,
    setIssuesOpen,
    setSlashSelected,
    setVoicePhase,
    unifiedChat,
    webChat,
    webCodeDraft,
    webReplyVoice,
    artifactOutput,
    bashAvailable,
    bashMode,
    compactPlaceholder,
    fullPlaceholder,
    issuesOpen,
    linearIssuesOpen,
    previewShown,
    promptPreview,
    recall,
    slashPlaceholderGone,
    slashTokenSelected,
    transcriptColumn,
    githubOpen,
  } = useComposerDraft({
    active,
    appContext,
    attachments,
    composer,
    draftIdentity,
    incognito,
    mode,
    notify,
    onFork,
    onShell,
    project,
    projectOverview,
    running,
    sending,
    setAttachments,
    setSettingsOpen,
    setText,
    text,
  });
  /** Bash mode's Send: runs the line; it stays in the box if it did not start. */
  const runBash = async () => {
    const command = text.trim();
    if (!command || !onShell) return;
    const identity = draftIdentity;
    setText("");
    setBashMode(false);
    if (await onShell(command)) return;
    if (identity !== currentDraft.current) return;
    setText(command);
    setBashMode(true);
  };
  // Send while files are still being added waits for them (useUploadQueue).
  const submitRef = useRef<(options?: { later?: boolean }) => void>(undefined);
  const uploads = useUploadQueue<{ later?: boolean }>(
    pending.length,
    draftIdentity,
    submitRef,
  );
  const reportAttachFailure = (error: unknown) => {
    uploads.cancel();
    report(error);
  };
  const submit = (options?: { later?: boolean }) => (
    history.reset(),
    coworkComputerWaiting(active)
      ? undefined
      : voicePhase !== "off"
        ? notify(t("End the voice session to continue"))
        : pending.length > 0 && !bash
          ? uploads.wait({ later: options?.later })
          : bash
            ? void runBash()
            : mode === "code" && active && /^\/loop(?:\s|$)/.test(text.trim())
              ? createLoop(text.trim().replace(/^\/loop\s*/, ""))
              : cloudCodeMissing
                ? notify(cloudCodeUnavailable)
                : cloudHome &&
                    !active &&
                    mode === "code" &&
                    !currentCodeRepository()
                  ? requestRepositoryPicker()
                  : unsupported
                    ? setModelMenu(true)
                    : void send(options)
  );
  submitRef.current = submit;
  const {
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
  } = useComposerSetup({
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
  });
  const {
    mention,
    mentioned,
    tokens: mentionTokens,
    open: mentionOpen,
  } = mentions;
  const skillRanges =
    mode !== "code" ? validSkillTokens(text, skillTokens) : [];
  const {
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
  } = useComposerActions({
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
    report: reportAttachFailure,
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
  });
  const {
    voicePlaceholderText,
    promptSuggestion,
    noticeVariant,
    inputRow,
    multiline,
    attachmentPicker,
    hasDraft,
    micButton,
    submitButton,
    conversation,
    trailingControls,
    foldingSubmit,
    toolbar,
    coworkTask,
    researchChip,
    chinVoice,
    modelPicker,
    taskPermissionPicker,
  } = useComposerControls({
    active,
    addMenu,
    appContext,
    attachments,
    bash,
    catalog,
    catalogRead,
    chooseFiles,
    codeHomeDraft,
    composer,
    cwd,
    dictation,
    dictationPhase,
    dictationTarget,
    draftIdentity,
    effortOpenRequest,
    extendedThinking,
    forkSendAvailable,
    host,
    inCloud,
    incognito,
    incognitoControls,
    interrupt,
    mode,
    model,
    modelMenu,
    narrow,
    notify,
    onCodePermissionChange,
    onCompact,
    onCreateProject,
    onHandOff,
    onProject,
    onResearch,
    onWebSearch,
    openModelService,
    openSettingsTab,
    openSkillsSettings,
    pending,
    uploadQueued: uploads.queued,
    pendingSlash,
    permissionOpenRequest,
    pickFolder,
    platform,
    policy,
    project,
    projects,
    providerId,
    recentFolders,
    report,
    research,
    researchAvailable,
    researchUnavailableReason,
    retired,
    reviewNotes,
    runPendingSlash,
    running,
    selectModel,
    sending,
    setAddMenu,
    setCwd,
    setDictationPhase,
    setEffortOpenRequest,
    setGithubOpen,
    setIssuesOpen,
    setLinearIssuesOpen,
    setModelMenu,
    setPendingSlash,
    setSkillTokens,
    setSlashDismissed,
    setSlashSelected,
    setText,
    setVoicePhase,
    settings,
    skillRanges,
    submit,
    text,
    thinkingMode,
    toggleThinking,
    unifiedChat,
    unsupported,
    updatePreference,
    updateRequired,
    voice,
    voicePhase,
    webChat,
    webCodeDraft,
    webReplyVoice,
    webSearch,
    webSearchAvailable,
  });
  const composerView = composerFrame({
    active,
    addMenu,
    appContext,
    artifactOutput,
    attachmentPicker,
    attachments,
    attachmentsAllowed,
    bash,
    bashAvailable,
    bashMode,
    boot,
    branchRow,
    caret,
    chinVoice,
    chooseSlash,
    cloudHome,
    codeHomeDraft,
    compactPlaceholder,
    composer,
    conversation,
    coworkTask,
    cwd,
    dictation,
    dictationPhase,
    dictationTarget,
    dock,
    draftIdentity,
    dropScope,
    dropState,
    firstRun,
    foldingSubmit,
    forkSendAvailable,
    frame,
    fullPlaceholder,
    hasDraft,
    history,
    host,
    inCloud,
    incognito,
    incognitoControls,
    inputRow,
    interrupt,
    issuesOpen,
    linearIssuesOpen,
    mention,
    mentionOpen,
    mentionTokens,
    mentioned,
    mentions,
    micButton,
    mode,
    modelMenu,
    modelPicker,
    multiline,
    noticeVariant,
    notify,
    onCreateProject,
    onFork,
    onNewProject,
    onPaste,
    onProject,
    pending,
    pendingSlash,
    pickFolder,
    platform,
    policy,
    previewShown,
    project,
    projectOverview,
    projects,
    promptPreview,
    promptSuggestion,
    queuedBar,
    recall,
    report,
    researchChip,
    reviewNotes,
    runAttachJobs,
    runPendingSlash,
    running,
    selectModel,
    selectedSlash,
    sending,
    setAttachments,
    setBashMode,
    setCaret,
    setCwd,
    setIssuesOpen,
    setLinearIssuesOpen,
    setPendingSlash,
    setSkillTokens,
    setSlashDismissed,
    setSlashPlaceholderGone,
    setSlashSelected,
    setSlashTokenSelected,
    setText,
    settings,
    skillRanges,
    slashCommands,
    slashOpen,
    slashPlaceholder,
    slashPlaceholderGone,
    slashQuery,
    slashTokenSelected,
    submit,
    submitButton,
    taskPermissionPicker,
    text,
    toolbar,
    trailingControls,
    transcriptColumn,
    unifiedChat,
    unsupported,
    updatePreference,
    updateRequired,
    voicePlaceholderText,
    webCodeDraft,
  });
  return (
    <>
      {composerView}
      {cacheChange.dialog}
      {githubOpen && (
        <Suspense fallback={null}>
          <ChatGitHubDialog
            key={draftIdentity}
            onClose={() => setGithubOpen(false)}
            onAttach={(attachment) => {
              setAttachments((value) =>
                value.some(
                  (file) =>
                    file.github?.repository === attachment.github?.repository &&
                    file.github?.branch === attachment.github?.branch,
                )
                  ? value
                  : [...value, attachment].slice(0, maxAttachmentsFor(mode)),
              );
            }}
          />
        </Suspense>
      )}
    </>
  );
}
