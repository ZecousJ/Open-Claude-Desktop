import { usePromptPreview } from "./prompt-preview";
import { useState, useMemo, useEffect, useRef } from "react";
import type { PendingAttachment } from "./Attachments";
import { doubleEscape } from "./double-escape";
import { chatComposerPlaceholder } from "./chat-placeholder";
import { useCompactPlaceholder } from "./useCompactPlaceholder";
import type { DictationPhase } from "./voice/DictationButton";
import type { VoicePhase } from "../voice/useVoiceMode";
import { t } from "../i18n";
import { usePromptHistory } from "./prompt-history";
import { usePolicy } from "../policy/PolicyContext";
import { useHost } from "../host/HostContext";
import { useChatTranscriptColumn } from "./useChatTranscriptColumn";
import { useRemoteEnvironment } from "../remote-control/environment";
import { useCodeCloud } from "./code-cloud";
import type {
  Conversation,
  Attachment,
  Mode,
  Project,
} from "../../shared/types";
import type { ComposerField } from "./composer-field";
import type { AppController } from "../app/AppContext";

/** What useComposerDraft needs from Composer.tsx. */
export interface UseComposerDraftKit {
  active: Conversation | undefined;
  appContext: AppController | undefined;
  attachments: Attachment[];
  composer: React.RefObject<ComposerField | null>;
  draftIdentity: string;
  incognito: boolean;
  mode: Mode;
  notify: (message: string) => void;
  onFork: ((prompt: string) => void) | undefined;
  onShell: ((command: string) => Promise<boolean>) | undefined;
  project: Project | undefined;
  projectOverview: boolean;
  running: boolean;
  sending: boolean;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setSettingsOpen: (open: boolean) => void;
  setText: React.Dispatch<React.SetStateAction<string>>;
  text: string;
}

export function useComposerDraft(kit: UseComposerDraftKit) {
  const {
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
  } = kit;
  // A home suggestion pointed at shows its prompt in place of the draft.
  const promptPreview = usePromptPreview();
  const previewShown = Boolean(promptPreview) && !active && mode !== "code";
  /** The model menus' Model service opens the API page. */
  const openModelService = () => {
    setModelMenu(false);
    if (appContext) appContext.setPage("api");
    else setSettingsOpen(true);
  };
  const [modelMenu, setModelMenu] = useState(false),
    [addMenu, setAddMenu] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0),
    [slashDismissed, setSlashDismissed] = useState(false),
    [pendingSlash, setPendingSlash] = useState<string | null>(null),
    // Backspace on a bare command token first drops its [argument] placeholder,
    // then selects the token, then deletes it.
    [slashPlaceholderGone, setSlashPlaceholderGone] = useState(false),
    [slashTokenSelected, setSlashTokenSelected] = useState(false);
  const [effortOpenRequest, setEffortOpenRequest] = useState(0),
    [permissionOpenRequest, setPermissionOpenRequest] = useState(0);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [githubOpen, setGithubOpen] = useState(false);
  const recall = useMemo(doubleEscape, [
    draftIdentity,
    mode,
    modelMenu,
    addMenu,
    running,
    sending,
    text,
    attachments.length,
    pending.length,
    githubOpen,
  ]);
  useEffect(() => setGithubOpen(false), [draftIdentity, mode]);
  const fullPlaceholder = chatComposerPlaceholder(
    mode === "cowork" ? "cowork" : "chat",
    Boolean(active),
    projectOverview,
    project?.name,
  );
  const compactPlaceholder = useCompactPlaceholder(
    composer,
    fullPlaceholder,
    mode === "cowork",
  );
  // Import GitHub issue's dialog (Code's new task page).
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [linearIssuesOpen, setLinearIssuesOpen] = useState(false);
  // Bash mode (Code): "!" typed into an empty draft turns the line into a
  // shell command run in the open session, not sent to the model (desktop
  // bundle 2.31226.1). Backspace in the empty box or Escape returns to chat.
  const [bashMode, setBashMode] = useState(false);
  // While dictation connects or listens, the placeholder says so.
  const [dictationPhase, setDictationPhase] = useState<DictationPhase>("idle");
  const dictationTarget = useRef<HTMLDivElement>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("off");
  const previousVoicePhase = useRef<VoicePhase>("off");
  useEffect(() => {
    if (
      previousVoicePhase.current === "off" &&
      voicePhase !== "off" &&
      attachments.length
    ) {
      setAttachments([]);
      notify(
        t(
          "File attachments were removed because the draft was reset after an unfinished voice conversation. Attach them again.",
        ),
      );
    }
    previousVoicePhase.current = voicePhase;
  }, [attachments.length, notify, setAttachments, voicePhase]);
  const bashAvailable =
    mode === "code" &&
    Boolean(active) &&
    !active?.incognito &&
    Boolean(onShell) &&
    !running &&
    !pendingSlash &&
    !attachments.length;
  const bash =
    bashMode && mode === "code" && Boolean(active) && Boolean(onShell);
  // Code: ⌥⌘↵ sends the draft in a forked session (its Send tooltip says so).
  const forkSendAvailable =
    mode === "code" && Boolean(onFork) && Boolean(active) && !active?.incognito;
  useEffect(() => setBashMode(false), [draftIdentity]);
  const [caret, setCaret] = useState(0);
  // ↑ and Ctrl+R bring back the session's earlier prompts (prompt-history.ts).
  const historyPrompts = useMemo(
    () =>
      mode === "code" && active
        ? active.turns
            .map((turn) => turn.prompt)
            .filter((prompt) => prompt.trim() !== "")
        : [],
    [mode, active?.id, active?.turns.length],
  );
  const history = usePromptHistory({
    prompts: historyPrompts,
    text,
    setText: (value, at) => {
      setText(value);
      const caretAt = at === "start" ? 0 : value.length;
      setCaret(caretAt);
      requestAnimationFrame(() =>
        composer.current?.setSelectionRange(caretAt, caretAt),
      );
    },
    field: composer,
    enabled: mode === "code" && Boolean(active) && !bash && !pendingSlash,
    resetKey: active?.id,
  });
  // A recalled or searched prompt is not typed: its "/" and "@" open nothing
  // and Enter sends it.
  const historyActive = history.hint !== null;
  const slashMatch =
    mode === "code" && !pendingSlash && !bash && !historyActive
      ? text.match(/^\/([^\s]*)$/)
      : null;
  const slashQuery = slashMatch?.[1] ?? "";
  const policy = usePolicy();
  const host = useHost();
  // The native transcript renderer reports a web host too, but installs
  // this controller before its first render (mobile-conversation/main.tsx).
  const webSurface =
    host.kind === "web" &&
    (typeof window === "undefined" || !("ClaudexConversation" in window));
  const webChat = webSurface && mode !== "code";
  // The current unified Chat uses the same model/permission topology on
  // desktop. The separate native controller and task windows keep their
  // own presentation (O16 shared-19 Jp; shared-8 Jv/Sf).
  const unifiedChat =
    mode !== "code" && (webSurface || host.kind === "desktop");
  const transcriptColumn = useChatTranscriptColumn(
    unifiedChat &&
      Boolean(active) &&
      Boolean(appContext) &&
      !projectOverview &&
      !appContext?.artifact &&
      !appContext?.panel,
    appContext?.controllerScope,
  );
  // Main incognito Chat retains its ordinary controls. The independent
  // native transcript/task projections keep their own privacy branches.
  const incognitoControls =
    !incognito ||
    (unifiedChat &&
      (!appContext?.windowRole || appContext.windowRole.kind === "main") &&
      (typeof window === "undefined" || !("ClaudexConversation" in window)));
  const webReplyVoice = webChat && Boolean(active) && incognitoControls;
  // Current native and web Code homes share the field/chin composition. Opened
  // sessions retain their own controls.
  const codeHomeDraft = mode === "code" && !active;
  const remoteCodeEnvironment = useRemoteEnvironment();
  const artifactOutput =
    codeHomeDraft && !remoteCodeEnvironment
      ? appContext?.composerDraft?.draftArtifactOutput
      : undefined;
  const webCodeDraft = webSurface && codeHomeDraft;
  useEffect(() => {
    if (codeHomeDraft && !modelMenu) setEffortOpenRequest(0);
  }, [codeHomeDraft, modelMenu]);
  // The web's Code page shows before the service runs Code in the cloud:
  // the draft can be written, but it cannot be sent yet.
  const cloudCodeMissing =
    mode === "code" &&
    !host.capabilities.localCode &&
    !host.capabilities.cloudCode;
  // The desktop's Code home in the cloud (Local ▾ › Cloud): a session there
  // starts with a GitHub repository (docs/cloud-sync.md P4).
  const inCloud = useCodeCloud() && host.capabilities.localCode;
  // The web's Code home, or the desktop's cloud environment: a repository, not a folder.
  const cloudHome = !host.capabilities.localCode || inCloud;
  return {
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
  } as const;
}
