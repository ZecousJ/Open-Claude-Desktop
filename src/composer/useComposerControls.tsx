import { AppIcon } from "../ui/app-icon";
import { codeLiveLayout } from "./code-live-layout";
import { Suspense, useEffect, useRef } from "react";
import {
  CodeReturnIcon,
  SubmitPill,
  VoiceModeButton,
  CloudWorkspaceBar,
  WorkspaceBar,
} from "./Composer";
import {
  WithTooltip,
  TooltipRows,
  showsShortcuts,
  shortcutText,
} from "../ui/Tooltip";
import { Spinner } from "../ui/Spinner";
import { t } from "../i18n";
import { RingedStopIcon } from "../ui/RingedStopIcon";
import { usePresence } from "../ui/usePresence";
import { coworkComputerWaiting } from "../../shared/remote-devices";
import { onComposerSubmitRequest } from "./submit-request";
import { CodeSubmitCell } from "./CodeSubmitCell";
import { TaskPermissionPicker } from "./TaskPermissionPicker";
import { useSpeechEngine } from "../voice/useSpeechEngine";
import {
  DictationButton,
  UnavailableDictationButton,
} from "./voice/DictationButton";
import { preference } from "../../shared/settings-extras";
import { CoworkVoiceControls } from "./voice/CoworkVoiceControls";
import { PreferredVoiceInput } from "./PreferredVoiceInput";
import { ContextRing } from "./ContextRing";
import { contextUsage } from "./context-usage";
import { CodePermissionPicker } from "./code/CodePermissionPicker";
import { useComposerMorph } from "./useComposerMorph";
import { voicePlaceholder } from "./voice-placeholder";
import type {
  Conversation,
  Attachment,
  Mode,
  Project,
  Settings,
} from "../../shared/types";
import type { ComposerField } from "./composer-field";
import type { DictationPhase } from "./voice/DictationButton";
import type { PendingAttachment } from "./Attachments";
import type { SkillToken } from "./skill-tokens";
import type { VoicePhase } from "../voice/useVoiceMode";
import type { AppController } from "../app/AppContext";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { HostInfo } from "../../shared/host";
import type { CodePermissionPatch } from "../../shared/code-session-permissions";
import type { ClientPolicy } from "../../shared/client-policy";
import type { RetiredModel } from "./retired-model";
import type { ReviewComment } from "../changes/review-comments";
import type { CodeModelChoice } from "./model/code-model-choices";
import type { VoiceAvailability } from "../../shared/voice-api";
import { useComposerPickers } from "./useComposerPickers";

/** What useComposerControls needs from Composer.tsx. */
export interface UseComposerControlsKit {
  active: Conversation | undefined;
  addMenu: boolean;
  appContext: AppController | undefined;
  attachments: Attachment[];
  bash: boolean;
  catalog: ModelCatalog | null;
  catalogRead: {
    retry: () => void;
    status: "ready" | "pending" | "error";
    value: ModelCatalog | null | undefined;
  };
  chooseFiles: () => void;
  codeHomeDraft: boolean;
  composer: React.RefObject<ComposerField | null>;
  cwd: string | undefined;
  dictation: {
    live: boolean;
    onLive(spoken: string): void;
    onTranscript(spoken: string): void;
    onCancel(): void;
  };
  dictationPhase: DictationPhase;
  dictationTarget: React.RefObject<HTMLDivElement | null>;
  draftIdentity: string;
  effortOpenRequest: number;
  extendedThinking: boolean;
  forkSendAvailable: boolean;
  host: HostInfo;
  inCloud: boolean;
  incognito: boolean;
  incognitoControls: boolean;
  interrupt: () => Promise<void>;
  mode: Mode;
  model: string;
  modelMenu: boolean;
  narrow: boolean;
  notify: (message: string) => void;
  onCodePermissionChange:
    ((patch: CodePermissionPatch) => Promise<void>) | undefined;
  onCompact: () => void;
  onCreateProject: (name?: string | undefined) => void;
  onHandOff: (() => void) | undefined;
  onProject: (id: string | null) => void;
  onResearch: (() => void) | undefined;
  onWebSearch: () => void;
  openModelService: () => void;
  openSettingsTab: (tab: string) => void;
  openSkillsSettings: (view: "yours" | "discover") => void;
  pending: PendingAttachment[];
  /** Send was pressed while files were still being added: it sends when they are in. */
  uploadQueued: boolean;
  pendingSlash: string | null;
  permissionOpenRequest: number;
  pickFolder: () => Promise<void>;
  platform: NodeJS.Platform;
  policy: ClientPolicy;
  project: Project | undefined;
  projects: Project[];
  providerId: string;
  recentFolders: string[];
  report: (error: unknown) => void;
  research: boolean;
  researchAvailable: boolean;
  researchUnavailableReason: string | undefined;
  retired: RetiredModel | undefined;
  reviewNotes: ReviewComment[];
  runPendingSlash: () => void;
  running: boolean;
  selectModel: (id: string, name: string) => void;
  sending: boolean;
  setAddMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setCwd: (cwd?: string | undefined) => void;
  setDictationPhase: React.Dispatch<React.SetStateAction<DictationPhase>>;
  setEffortOpenRequest: React.Dispatch<React.SetStateAction<number>>;
  setGithubOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIssuesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setLinearIssuesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setModelMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingSlash: React.Dispatch<React.SetStateAction<string | null>>;
  setSkillTokens: ((tokens: SkillToken[]) => void) | undefined;
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashSelected: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  setVoicePhase: React.Dispatch<React.SetStateAction<VoicePhase>>;
  settings: Settings;
  skillRanges: SkillToken[];
  submit: (options?: { later?: boolean | undefined } | undefined) => void;
  text: string;
  thinkingMode: "standard" | "extended";
  toggleThinking: (() => Promise<void>) | undefined;
  unifiedChat: boolean;
  unsupported: { fallback: CodeModelChoice; hint: string } | undefined;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  updateRequired: boolean;
  voice: VoiceAvailability | undefined;
  voicePhase: VoicePhase;
  webChat: boolean;
  webCodeDraft: boolean;
  webReplyVoice: boolean;
  webSearch: boolean;
  webSearchAvailable: boolean;
}

export function useComposerControls(kit: UseComposerControlsKit) {
  const {
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
    uploadQueued,
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
  } = kit;
  const {
    plainGlyphs,
    chatStopFace,
    stopping,
    stopLabel,
    hasDraft,
    attachmentPicker,
    researchChip,
    modelPicker,
    effortPicker,
  } = useComposerPickers({
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
    dictation,
    effortOpenRequest,
    extendedThinking,
    host,
    inCloud,
    incognito,
    incognitoControls,
    interrupt,
    mode,
    model,
    modelMenu,
    notify,
    onCreateProject,
    onProject,
    onResearch,
    onWebSearch,
    openModelService,
    openSettingsTab,
    openSkillsSettings,
    pending,
    pendingSlash,
    pickFolder,
    platform,
    project,
    projects,
    providerId,
    report,
    research,
    researchAvailable,
    researchUnavailableReason,
    retired,
    reviewNotes,
    running,
    selectModel,
    sending,
    setAddMenu,
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
    settings,
    skillRanges,
    text,
    thinkingMode,
    toggleThinking,
    unifiedChat,
    updatePreference,
    webChat,
    webSearch,
    webSearchAvailable,
  });
  const stopButton =
    mode !== "code" ? (
      plainGlyphs ? (
        <WithTooltip label="Stop response" shortcut={["Esc"]}>
          {chatStopFace}
        </WithTooltip>
      ) : (
        chatStopFace()
      )
    ) : (
      <WithTooltip
        label={stopping ? "Stopping…" : stopLabel}
        shortcut={["Esc"]}
      >
        {(tip) => (
          <button
            {...tip}
            className={`send-button stop ${plainGlyphs ? "plain" : ""}`}
            aria-label={stopLabel}
            aria-busy={stopping || undefined}
            onClick={() => {
              void interrupt().catch(report);
            }}
          >
            {stopping ? (
              <Spinner
                inheritColor
                size={plainGlyphs ? 16 : 14}
                className="spin"
              />
            ) : plainGlyphs ? (
              <RingedStopIcon />
            ) : (
              <RingedStopIcon size={13} />
            )}
          </button>
        )}
      </WithTooltip>
    );
  // Stop fades in when a turn starts and out when it ends, over 75ms after
  // 50ms (the original's composer control).
  const stopPresence = usePresence(running, 125);
  const stopSlot = stopPresence.mounted && (
    <span
      className="composer-stop-slot"
      data-state={stopPresence.state}
      inert={!running || undefined}
    >
      {stopButton}
    </span>
  );
  // A cloud Code home that cannot start a session keeps Send: pressing it says
  // why.
  const sendDisabled =
    coworkComputerWaiting(active) ||
    Boolean(unsupported) ||
    updateRequired ||
    sending ||
    dictation.live ||
    !hasDraft ||
    uploadQueued;
  // Asked from elsewhere to send (a split pane's "Start session" when it
  // closes with this draft): the same as pressing Send now.
  const requestedSubmit = useRef(() => {});
  const requestedResources = useRef(false);
  requestedResources.current = attachments.length > 0 || pending.length > 0;
  requestedSubmit.current = () => {
    if (!sendDisabled && !pendingSlash) submit();
  };
  useEffect(
    () =>
      onComposerSubmitRequest(
        draftIdentity,
        () => requestedSubmit.current(),
        () => requestedResources.current,
      ),
    [draftIdentity],
  );
  const sendLabel = mode === "code" ? "Send" : "Send message";
  const sendFace = (tip: Record<string, unknown> = {}) => (
    <button
      className={`send-button ${hasDraft ? "" : "idle"} ${plainGlyphs ? "plain" : ""}`}
      aria-label={uploadQueued ? t("Waiting for uploads") : sendLabel}
      aria-busy={uploadQueued || undefined}
      disabled={sendDisabled}
      onClick={() => (pendingSlash ? runPendingSlash() : submit())}
      {...tip}
    >
      {sending || uploadQueued ? (
        <Spinner inheritColor size={plainGlyphs ? 20 : 15} className="spin" />
      ) : mode === "code" ? (
        <CodeReturnIcon width={plainGlyphs ? 15 : 11} />
      ) : (
        <AppIcon
          name={plainGlyphs ? "ArrowReturn" : "ComposerSend"}
          size={plainGlyphs ? 20 : 16}
        />
      )}
    </button>
  );
  // A focused or hovered Chat / Cowork Send says "Send message". Code's Send
  // says "Send ↵", and while a turn runs also how to queue for later. While a
  // reply runs, ⌘↵ queues instead of steering it; at rest a Code session's Send
  // also names ⌥⌘↵. Code's tooltip is several lines, each its words and its own
  // keys.
  const codeSendRows =
    mode === "code" && showsShortcuts && (running || forkSendAvailable)
      ? [
          { label: sendLabel, keys: ["↵"] },
          running
            ? { label: "Queue for later", keys: ["mod", "↵"] }
            : { label: "Send in a forked session", keys: ["alt", "mod", "↵"] },
        ]
      : undefined;
  const sendButton = (
    <WithTooltip
      label={sendLabel}
      content={
        codeSendRows && <TooltipRows platform={platform} rows={codeSendRows} />
      }
      shortcut={
        codeSendRows
          ? undefined
          : running || mode === "code"
            ? ["↵"]
            : undefined
      }
      detail={
        codeSendRows
          ? undefined
          : running && showsShortcuts
            ? `Queue for later ${shortcutText(platform, ["mod", "↵"])}`
            : forkSendAvailable && showsShortcuts
              ? `Send in a forked session ${shortcutText(platform, ["alt", "mod", "↵"])}`
              : undefined
      }
      disabled={sendDisabled}
    >
      {sendFace}
    </WithTooltip>
  );
  // Stop and Send share a spring-driven capsule; Code keeps its own submit
  // cell.
  const foldSendShown = !running || hasDraft;
  // Code's Stop and Send share one place: Stop while a turn runs with nothing
  // to send, Send otherwise, so a draft written mid-turn swaps Stop for Send
  // (Esc still stops).
  const submitButton = (
    <CodeSubmitCell
      showStop={running && !hasDraft}
      stop={stopButton}
      send={sendButton}
    />
  );
  const foldingSubmit =
    mode !== "code" ? (
      <Suspense
        fallback={
          <span className="composer-submit">
            {running ? stopButton : sendButton}
          </span>
        }
      >
        <SubmitPill
          reply={plainGlyphs}
          running={running}
          hasContent={hasDraft}
          stop={stopButton}
          send={sendButton}
        />
      </Suspense>
    ) : (
      <span className="composer-submit">
        {stopSlot}
        <span
          className="composer-send-fold"
          data-shown={foldSendShown || undefined}
          data-after-stop={running || undefined}
          inert={!foldSendShown || undefined}
        >
          <span>{sendButton}</span>
        </span>
      </span>
    );
  // Unbound task conversations use Cowork labels; the unified home uses hub
  // labels.
  const taskPermissionPicker = (
    <TaskPermissionPicker
      presentation={unifiedChat ? "web-chat" : "legacy"}
      settings={settings}
      sessionType="hub"
      // A cloud task from this computer runs with the mode chosen here
      // (the prompt carries it), so only the web limits its modes.
      cloud={
        host.kind === "web" &&
        (!active ||
          (active.environment?.kind === "space" && !active.linkedToComputer))
      }
      supportedModes={host.cloud?.permissionModes}
      onChange={(taskPermission) =>
        void updatePreference({ taskPermission }).catch(report)
      }
    />
  );
  // Dictation works when the administrator allows voice and the service can
  // transcribe; otherwise the microphone stays in its place, greyed, saying why.
  const speechEngine = useSpeechEngine(policy.voice, voice);
  const dictationOn = speechEngine !== undefined;
  const dictationReason = dictationOn
    ? undefined
    : policy.voice
      ? "Dictation isn't available right now"
      : "Your administrator turned dictation off";
  const micButton = dictationOn ? (
    <DictationButton
      containTooltip={codeHomeDraft}
      contextMenu={mode === "code" && codeHomeDraft}
      recordingTarget={dictationTarget}
      engine={speechEngine}
      onPhase={setDictationPhase}
      maxSeconds={
        speechEngine === "service" ? (voice?.maxSeconds ?? null) : null
      }
      contextKey={draftIdentity}
      onLive={dictation.onLive}
      onTranscript={dictation.onTranscript}
      onCancel={dictation.onCancel}
      onError={report}
      shortcut={preference(settings, "dictationShortcut")}
      platform={platform}
    />
  ) : (
    <UnavailableDictationButton
      containTooltip={codeHomeDraft}
      reason={dictationReason!}
    />
  );
  // The Chat and Cowork home: an empty composer shows the microphone and,
  // greyed, the original's voice mode (Chat) or voice options (Cowork) after
  // it; once there is something to send, Send replaces it. Stop comes first
  // while a turn runs. While dictation writes the draft, the microphone keeps
  // its place (Send would otherwise replace it and unmount the recording).
  const coworkTask = mode === "cowork" && Boolean(active);
  // Chat and Cowork conversations share one composer: the frame holds only the
  // message and Stop / Send; "+", the microphone, the disclaimer and the model
  // sit in the row under it.
  const conversation = mode !== "code" && Boolean(active);
  // Send and the microphone share one place and cross-fade in 60ms (the
  // original's send and idle slots); the microphone stays mounted under Send,
  // so a recording is never cut off by the draft it writes.
  const sendShown = hasDraft && !dictation.live;
  // Chat and Cowork homes keep Dictate and its caret in place with a draft;
  // Send takes only voice mode's place.
  const chatActions = (
    <>
      {mode !== "code" && (
        <div className="composer-home-voice">
          <CoworkVoiceControls
            microphone={micButton}
            label="Voice controls"
            menuVariant={host.kind === "web" ? "idle" : "legacy"}
            options
            optionsReason={dictationReason}
          />
        </div>
      )}
      <div className="composer-send-stack">
        <div
          className="composer-send-slot"
          data-shown={running || sendShown || undefined}
          inert={(!running && !sendShown) || undefined}
        >
          <Suspense
            fallback={
              <span className="composer-submit">
                {running ? stopButton : sendButton}
              </span>
            }
          >
            <SubmitPill
              running={running}
              hasContent={sendShown}
              stop={stopButton}
              send={sendButton}
            />
          </Suspense>
        </div>
        <div
          className="composer-idle-slot"
          data-shown={(!running && !sendShown) || undefined}
          inert={running || sendShown || undefined}
        >
          {mode !== "code" ? (
            <>
              {incognitoControls && (
                <Suspense
                  fallback={
                    <span
                      className="composer-home-voice-placeholder"
                      aria-hidden="true"
                    />
                  }
                >
                  <VoiceModeButton
                    waveform
                    microphoneOptions={false}
                    iconSize={20}
                    reason={dictationReason}
                    maxSeconds={voice?.maxSeconds ?? null}
                    engine={speechEngine}
                    onPhase={setVoicePhase}
                  />
                </Suspense>
              )}
            </>
          ) : (
            <CoworkVoiceControls
              microphone={micButton}
              options
              optionsReason={dictationReason}
            />
          )}
        </div>
      </div>
    </>
  );
  // A conversation's microphone sits in the row under the frame, 4px after "+".
  // In Chat its microphone menu and a separate voice action stay visible with a
  // draft. Draft edits retain the chosen primary control. The single-control web
  // reply layout offers the source pinned input action; split layouts keep
  // separate dictation and voice actions.
  const chinVoice = (
    <div className="composer-chin-voice">
      {webReplyVoice ? (
        // Dictate, then voice mode as a split button whose caret opens the
        // microphone options.
        <div
          className="cowork-voice-controls chin-voice-controls"
          role="group"
          aria-label="Voice controls"
        >
          {micButton}
          <Suspense
            fallback={
              <span className="voice-mode-button" aria-hidden="true">
                <span className="voice-mode-main" />
              </span>
            }
          >
            <VoiceModeButton
              variant="reply"
              waveform
              iconSize={16}
              reason={dictationReason}
              maxSeconds={voice?.maxSeconds ?? null}
              engine={speechEngine}
              onPhase={setVoicePhase}
            />
          </Suspense>
        </div>
      ) : (
        <CoworkVoiceControls
          className="chin-voice-controls"
          label="Voice controls"
          menuVariant={
            host.kind === "web" && mode !== "code" ? "idle" : "legacy"
          }
          microphone={micButton}
          options={!webReplyVoice}
          optionsReason={dictationReason}
        />
      )}
      {mode !== "code" && incognitoControls && !webReplyVoice && (
        <Suspense
          fallback={
            <span className="voice-mode-button standalone" aria-hidden="true">
              <span className="voice-mode-main" />
            </span>
          }
        >
          <VoiceModeButton
            waveform
            microphoneOptions={false}
            reason={dictationReason}
            maxSeconds={voice?.maxSeconds ?? null}
            engine={speechEngine}
            onPhase={setVoicePhase}
          />
        </Suspense>
      )}
    </div>
  );
  const ring =
    mode === "code" ? (
      <ContextRing
        usage={contextUsage(active, catalog, model)}
        onCompact={active ? onCompact : undefined}
        compactReason={
          running || sending
            ? "Available when Claudex finishes this turn"
            : undefined
        }
      />
    ) : null;
  const cloudWorkspaceBar = (
    <Suspense
      fallback={
        codeHomeDraft ? (
          <span
            className="web-code-draft-workspace-placeholder"
            aria-hidden="true"
          />
        ) : null
      }
    >
      <CloudWorkspaceBar webDraft={webCodeDraft} />
    </Suspense>
  );
  const localWorkspaceBar =
    mode === "code" && !active && host.capabilities.localCode && !inCloud ? (
      <Suspense fallback={null}>
        <WorkspaceBar
          homeDraft={codeHomeDraft}
          cwd={cwd}
          recentFolders={recentFolders}
          project={project}
          setCwd={setCwd}
          pickFolder={pickFolder}
        />
      </Suspense>
    ) : null;
  const toolbar = (
    <div
      className="composer-toolbar"
      data-dictating={dictationPhase !== "idle" || undefined}
    >
      {!conversation && (
        <div className="composer-dictation-target" ref={dictationTarget} />
      )}
      <div className="composer-left">
        {codeHomeDraft
          ? !host.capabilities.localCode || inCloud
            ? cloudWorkspaceBar
            : localWorkspaceBar
          : codeLiveLayout(mode, host, codeHomeDraft)
            ? null
            : attachmentPicker}
        {researchChip}
        {mode === "code" ? (
          <>
            {!codeLiveLayout(mode, host, codeHomeDraft) && micButton && (
              <CoworkVoiceControls
                className="code-voice-controls"
                label="Voice controls"
                microphone={micButton}
                options
                optionsReason={dictationReason}
              />
            )}
            <CodePermissionPicker
              sessionScoped={Boolean(onCodePermissionChange)}
              pendingStart={sending}
              homeDraft={codeHomeDraft}
              platform={platform}
              sandbox={settings.codeSandbox}
              autoAcceptEdits={settings.autoAcceptEdits}
              planMode={settings.codePlanMode}
              cwd={active ? active.cwd : cwd}
              bypassFolders={settings.bypassFolders}
              openRequest={permissionOpenRequest}
              supportedModes={
                host.kind === "web" ? host.cloud?.permissionModes : undefined
              }
              onChange={(patch) => void updatePreference(patch).catch(report)}
              onUnavailable={notify}
              turnRunning={running}
              onNotice={notify}
            />
          </>
        ) : null}
      </div>
      <div className="composer-right">
        {/* Chat and Cowork show the model in the row under the frame. */}
        {mode === "code" && modelPicker}
        {effortPicker}
        {mode !== "code" && (
          <div className={`composer-action-slot ${mode}`}>{chatActions}</div>
        )}
        {ring}
      </div>
    </div>
  );
  // The conversation composer's one row turns into two (the text over Stop
  // and Send) once the draft needs the room. Nothing leads the text in the
  // frame since "+" moved to the row under it.
  const inputRow = useRef<HTMLDivElement>(null),
    noLeadingControls = useRef<HTMLDivElement>(null),
    trailingControls = useRef<HTMLDivElement>(null);
  const multiline = useComposerMorph(
    conversation,
    inputRow,
    noLeadingControls,
    trailingControls,
    composer,
    text,
  );
  const noticeVariant = !active ? "home" : narrow ? "narrow" : "conversation";
  const voicePlaceholderText = voicePlaceholder(dictationPhase, voicePhase);
  const promptSuggestion =
    mode === "code" &&
    !running &&
    !sending &&
    !text &&
    !attachments.length &&
    !bash &&
    !pendingSlash &&
    preference(settings, "ccPromptSuggestions") &&
    active?.promptSuggestion?.turnId === active?.turns.at(-1)?.id
      ? active?.promptSuggestion?.text
      : undefined;
  return {
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
  } as const;
}
