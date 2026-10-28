import type { HistoryHint } from "./prompt-history";
import { codeLiveLayout } from "./code-live-layout";
import { Suspense } from "react";
import {
  UnsupportedModel,
  ImportLinearIssueDialog,
  ImportIssueDialog,
  RemoteControlNotice,
  TaskSuggestions,
  NextSteps,
} from "./Composer";
import { currentCodeRepository } from "./code-repository";
import { repositoryFullName } from "../../shared/github-api";
import { maxAttachmentsFor, attachmentLimitNotice } from "./attachment-limits";
import { ComposerNotices } from "../policy/ComposerNotice";
import { SleepBand } from "../code-sleep/SleepBand";
import { WorkflowSizeBand } from "../workflow-size/WorkflowSizeBand";
import { HostBanner } from "./QueuedMessages";
import { AuthIssueBanner } from "./AuthIssueBanner";
import { CoworkTaskFolderButton } from "../cowork/CoworkTaskFolderButton";
import { ChinDisclaimer } from "./ChinDisclaimer";
import { CoworkOptions } from "./CoworkOptions";
import { appendTaskPrompt } from "../../shared/task-backlog";
import type {
  Conversation,
  Attachment,
  Mode,
  Project,
  Settings,
} from "../../shared/types";
import type { CodeSlashCommand } from "./code/code-slash-commands";
import type { ComposerField } from "./composer-field";
import type { DictationPhase } from "./voice/DictationButton";
import type { FileDropScope, FileDropState } from "./useFileDrop";
import type { PendingAttachment } from "./Attachments";
import type { SkillToken } from "./skill-tokens";
import type { AppController } from "../app/AppContext";
import type { HostInfo } from "../../shared/host";
import type { MentionMatch, MentionRange } from "./mention";
import type { MentionFile } from "../../shared/composer-api";
import type { ClientPolicy } from "../../shared/client-policy";
import type { ReviewComment } from "../changes/review-comments";
import type { CodeModelChoice } from "./model/code-model-choices";
import { ComposerCard } from "./ComposerCard";
import { messageFieldPropsOf } from "./message-field-props";

/** What composerFrame needs from Composer.tsx. */
export interface ComposerFrameKit {
  active: Conversation | undefined;
  addMenu: boolean;
  appContext: AppController | undefined;
  artifactOutput: "docs" | "slides" | "design" | "dashboard" | undefined;
  attachmentPicker: React.JSX.Element;
  attachments: Attachment[];
  attachmentsAllowed: boolean;
  bash: boolean;
  bashAvailable: boolean;
  bashMode: boolean;
  boot: boolean;
  branchRow: React.ReactNode;
  caret: number;
  chinVoice: React.JSX.Element;
  chooseSlash: (command: CodeSlashCommand) => void;
  cloudHome: boolean;
  codeHomeDraft: boolean;
  compactPlaceholder: boolean;
  composer: React.RefObject<ComposerField | null>;
  conversation: boolean;
  coworkTask: boolean;
  cwd: string | undefined;
  dictation: {
    live: boolean;
    onLive(spoken: string): void;
    onTranscript(spoken: string): void;
    onCancel(): void;
  };
  dictationPhase: DictationPhase;
  dictationTarget: React.RefObject<HTMLDivElement | null>;
  dock: React.ReactNode;
  draftIdentity: string;
  dropScope: FileDropScope;
  dropState: FileDropState;
  firstRun: boolean;
  foldingSubmit: React.JSX.Element;
  forkSendAvailable: boolean;
  frame: React.RefObject<HTMLDivElement | null>;
  fullPlaceholder: string;
  hasDraft: boolean;
  history: {
    hint: HistoryHint | null;
    onKeyDown: (event: React.KeyboardEvent<ComposerField>) => boolean;
    reset: () => void;
  };
  host: HostInfo;
  inCloud: boolean;
  incognito: boolean;
  incognitoControls: boolean;
  inputRow: React.RefObject<HTMLDivElement | null>;
  interrupt: () => Promise<void>;
  issuesOpen: boolean;
  linearIssuesOpen: boolean;
  mention: MentionMatch | null;
  mentionOpen: boolean;
  mentionTokens: MentionRange[];
  mentioned: string[];
  mentions: {
    mentioned: string[];
    tokens: MentionRange[];
    mention: MentionMatch | null;
    open: boolean;
    files: MentionFile[];
    loading: boolean;
    selected: number;
    setSelected: React.Dispatch<React.SetStateAction<number>>;
    choose: (file: MentionFile) => void;
    keyDown: (e: React.KeyboardEvent<HTMLElement>) => boolean;
    dismiss: () => void | null;
    reset: () => void;
  };
  micButton: React.JSX.Element;
  mode: Mode;
  modelMenu: boolean;
  modelPicker: React.JSX.Element;
  multiline: boolean;
  noticeVariant: "home" | "narrow" | "conversation";
  notify: (message: string) => void;
  onCreateProject: (name?: string | undefined) => void;
  onFork: ((prompt: string) => void) | undefined;
  onNewProject: ((name?: string | undefined) => void) | undefined;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onProject: (id: string | null) => void;
  pending: PendingAttachment[];
  pendingSlash: string | null;
  pickFolder: () => Promise<void>;
  platform: NodeJS.Platform;
  policy: ClientPolicy;
  previewShown: boolean;
  project: Project | undefined;
  projectOverview: boolean;
  projects: Project[];
  promptPreview: string | null;
  promptSuggestion: string | undefined;
  queuedBar: React.ReactNode;
  recall: (
    event: {
      key: string;
      repeat: boolean;
      isComposing: boolean;
      defaultPrevented: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    },
    enabled: boolean,
    now?: number,
  ) => boolean;
  report: (error: unknown) => void;
  researchChip: React.JSX.Element;
  reviewNotes: ReviewComment[];
  runAttachJobs: (
    jobs: {
      key: string;
      name: string;
      image?: boolean | undefined;
      preview?: string | undefined;
      run: () => Promise<Attachment>;
    }[],
  ) => Promise<void>;
  runPendingSlash: () => void;
  running: boolean;
  selectModel: (id: string, name: string) => void;
  selectedSlash: number;
  sending: boolean;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setBashMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCaret: React.Dispatch<React.SetStateAction<number>>;
  setCwd: (cwd?: string | undefined) => void;
  setIssuesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setLinearIssuesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingSlash: React.Dispatch<React.SetStateAction<string | null>>;
  setSkillTokens: ((tokens: SkillToken[]) => void) | undefined;
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashPlaceholderGone: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashSelected: React.Dispatch<React.SetStateAction<number>>;
  setSlashTokenSelected: React.Dispatch<React.SetStateAction<boolean>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  settings: Settings;
  skillRanges: SkillToken[];
  slashCommands: CodeSlashCommand[];
  slashOpen: boolean;
  slashPlaceholder: string;
  slashPlaceholderGone: boolean;
  slashQuery: string;
  slashTokenSelected: boolean;
  submit: (options?: { later?: boolean | undefined } | undefined) => void;
  submitButton: React.JSX.Element;
  taskPermissionPicker: React.JSX.Element;
  text: string;
  toolbar: React.JSX.Element;
  trailingControls: React.RefObject<HTMLDivElement | null>;
  transcriptColumn: React.RefObject<HTMLDivElement | null>;
  unifiedChat: boolean;
  unsupported: { fallback: CodeModelChoice; hint: string } | undefined;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  updateRequired: boolean;
  voicePlaceholderText:
    | "Connecting..."
    | "Listening..."
    | "Reconnecting..."
    | "Processing..."
    | "Claudex is speaking..."
    | undefined;
  webCodeDraft: boolean;
}

export function composerFrame(kit: ComposerFrameKit) {
  const {
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
  } = kit;
  const messageFieldProps = messageFieldPropsOf({
    active,
    addMenu,
    artifactOutput,
    attachments,
    bash,
    bashAvailable,
    caret,
    chooseSlash,
    compactPlaceholder,
    composer,
    dictation,
    firstRun,
    forkSendAvailable,
    fullPlaceholder,
    history,
    host,
    mentioned,
    mentions,
    mode,
    modelMenu,
    onFork,
    onPaste,
    pending,
    pendingSlash,
    platform,
    previewShown,
    promptSuggestion,
    recall,
    reviewNotes,
    runPendingSlash,
    running,
    selectedSlash,
    sending,
    setBashMode,
    setCaret,
    setPendingSlash,
    setSlashDismissed,
    setSlashPlaceholderGone,
    setSlashSelected,
    setSlashTokenSelected,
    setText,
    skillRanges,
    slashCommands,
    slashOpen,
    slashPlaceholder,
    slashPlaceholderGone,
    slashTokenSelected,
    submit,
    text,
    updateRequired,
    voicePlaceholderText,
  });
  const messageField = <textarea {...messageFieldProps} />;
  const composerView = (
    <div
      ref={transcriptColumn}
      className={`composer-wrap ${mode === "code" ? "code-composer" : "chat-composer"} ${active ? "conversation-composer" : ""} ${codeHomeDraft ? "code-home-composer" : ""} ${webCodeDraft ? "web-code-draft" : ""}${!codeHomeDraft && codeLiveLayout(mode, host, codeHomeDraft) ? " code-live-composer" : ""}`}
      data-presentation={unifiedChat ? "chat" : undefined}
      data-project-overview={projectOverview || undefined}
      data-boot={boot || undefined}
    >
      {dock}
      {unsupported && (
        <Suspense fallback={null}>
          <UnsupportedModel
            notice={unsupported}
            onSwitch={(id, name) => {
              void selectModel(id, name);
            }}
          />
        </Suspense>
      )}
      {queuedBar}
      {branchRow}
      {linearIssuesOpen && !active && mode === "code" && (
        <Suspense fallback={null}>
          <ImportLinearIssueDialog
            onSelect={(issue) =>
              appContext?.composerDraft.setDraftLinearIssue(issue)
            }
            onClose={() => setLinearIssuesOpen(false)}
          />
        </Suspense>
      )}
      {issuesOpen && (
        <Suspense fallback={null}>
          <ImportIssueDialog
            // The web's chosen repository, else the new task's folder.
            repository={
              cloudHome && currentCodeRepository()
                ? repositoryFullName(currentCodeRepository()!.url)
                : undefined
            }
            folder={cloudHome ? undefined : cwd}
            // The chosen issue is an attachment of the next message.
            onAttach={(job) => {
              const limit = maxAttachmentsFor(mode);
              if (limit - attachments.length - pending.length <= 0)
                return notify(attachmentLimitNotice(limit));
              void runAttachJobs([job]);
            }}
            onClose={() => setIssuesOpen(false)}
          />
        </Suspense>
      )}
      <ComposerNotices variant={noticeVariant} mode={mode} onError={report} />
      {active?.mode === "code" && (
        <Suspense fallback={null}>
          <RemoteControlNotice conversation={active} />
        </Suspense>
      )}
      {active?.mode === "code" && (
        <SleepBand
          conversation={active}
          variant={noticeVariant}
          settings={settings}
          updatePreference={updatePreference}
          onError={report}
        />
      )}
      {active?.mode === "code" && (
        <WorkflowSizeBand
          conversation={active}
          variant={noticeVariant}
          onView={() =>
            appContext?.toolPanels.isOpen("background") ||
            appContext?.toolPanels.toggle("background")
          }
          onError={report}
        />
      )}
      <HostBanner conversationId={active?.id} />
      <AuthIssueBanner
        error={active?.turns.at(-1)?.error}
        turnId={active?.turns.at(-1)?.id}
      />
      {bashAvailable || bash ? (
        <span role="status" className="sr-only">
          {bash ? "Bash mode. Press Escape to return to chat." : "Chat mode"}
        </span>
      ) : null}
      {/* The chin's note shows here when the chin has no room for it. */}
      {conversation && <div className="composer-disclaimer-above" />}
      <ComposerCard
        active={active}
        appContext={appContext}
        artifactOutput={artifactOutput}
        attachmentPicker={attachmentPicker}
        attachments={attachments}
        bash={bash}
        chooseSlash={chooseSlash}
        codeHomeDraft={codeHomeDraft}
        composer={composer}
        conversation={conversation}
        dictation={dictation}
        dictationPhase={dictationPhase}
        draftIdentity={draftIdentity}
        dropScope={dropScope}
        dropState={dropState}
        foldingSubmit={foldingSubmit}
        frame={frame}
        hasDraft={hasDraft}
        history={history}
        host={host}
        inputRow={inputRow}
        interrupt={interrupt}
        mention={mention}
        mentionOpen={mentionOpen}
        mentionTokens={mentionTokens}
        mentions={mentions}
        messageField={messageField}
        micButton={micButton}
        mode={mode}
        multiline={multiline}
        pending={pending}
        pendingSlash={pendingSlash}
        previewShown={previewShown}
        promptPreview={promptPreview}
        report={report}
        reviewNotes={reviewNotes}
        running={running}
        selectedSlash={selectedSlash}
        setAttachments={setAttachments}
        setCaret={setCaret}
        setSkillTokens={setSkillTokens}
        setSlashDismissed={setSlashDismissed}
        setSlashSelected={setSlashSelected}
        setText={setText}
        skillRanges={skillRanges}
        slashCommands={slashCommands}
        slashOpen={slashOpen}
        slashQuery={slashQuery}
        slashTokenSelected={slashTokenSelected}
        submit={submit}
        submitButton={submitButton}
        text={text}
        toolbar={toolbar}
        trailingControls={trailingControls}
        unifiedChat={unifiedChat}
      />
      {/* The row under a Chat or Cowork frame. In a conversation: "+", the chips
         and the microphone at the left, the disclaimer centred, the model at
         the right. On the home: the project (Chat) or the project or folder and
         Output (Cowork) at the left, the model at the right. */}
      {conversation && (
        <div
          className="composer-chin conversation-footer"
          data-dictating={dictationPhase !== "idle" || undefined}
        >
          <div className="composer-dictation-target" ref={dictationTarget} />
          <div className="composer-chin-leading">
            {attachmentPicker}
            {/* A Chat conversation adds a folder from "+". Tasks now open in
               Chat too, and the live chin of a task chat has no folder button;
               only a task's own window keeps it. */}
            {active && coworkTask && !unifiedChat && (
              <CoworkTaskFolderButton conversation={active} />
            )}
            {mode === "chat" && researchChip}
            {chinVoice}
          </div>
          <ChinDisclaimer
            conversation={active}
            unified={unifiedChat}
            help={policy.links.help}
            short={incognito}
            second={
              active?.turns.some((turn) =>
                turn.items.some(
                  (item) => item.sources?.length || item.citations?.length,
                ),
              )
                ? "Please double-check cited sources."
                : undefined
            }
          />
          <div className="composer-chin-trailing">
            {modelPicker}
            {/* A scheduled task's run always has full access, so it shows no
               permission mode; nor does a task from an outside prompt, which
               always asks first. */}
            {incognitoControls &&
              !active?.scheduledRun &&
              !active?.asksFirst &&
              taskPermissionPicker}
          </div>
        </div>
      )}
      {mode !== "code" && !active && (
        <div className="composer-chin" data-place="home">
          <div className="composer-chin-leading">
            {incognitoControls && !projectOverview && (
              <CoworkOptions
                key={mode}
                variant="chat"
                projectsOnly={incognito}
                platform={platform}
                cwd={cwd}
                setCwd={setCwd}
                project={project}
                projects={projects}
                onProject={onProject}
                onCreateProject={onCreateProject}
                onNewProject={onNewProject}
                pickFolder={pickFolder}
              />
            )}
          </div>
          <div className="composer-chin-trailing">
            {modelPicker}
            {incognitoControls && taskPermissionPicker}
          </div>
        </div>
      )}
      {mode === "code" && toolbar}
      {mode === "code" && !inCloud && (
        <Suspense fallback={null}>
          <TaskSuggestions
            cwd={cwd}
            conversation={active}
            canTake={!bashMode}
            onPrompt={(prompt) => {
              setText((current) => appendTaskPrompt(current, prompt));
              requestAnimationFrame(() => composer.current?.focus());
            }}
          />
        </Suspense>
      )}
      {mode === "code" &&
        !active &&
        host.capabilities.localCode &&
        !inCloud && (
          <Suspense fallback={null}>
            <NextSteps
              cwd={cwd}
              onPrompt={(prompt) => {
                setText(prompt);
                requestAnimationFrame(() => composer.current?.focus());
              }}
            />
          </Suspense>
        )}
    </div>
  );
  return composerView;
}
