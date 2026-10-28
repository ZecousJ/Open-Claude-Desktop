import { PixelMascot } from "./PixelMascot";
import { t, formatText } from "../i18n";
import { commentWhere, removeReviewComment } from "../changes/review-comments";
import { AttachmentList } from "./Attachments";
import { Suspense } from "react";
import { LinearIssuePill, DropOverlay } from "./Composer";
import { CodeSlashPalette } from "./code/CodeSlashPalette";
import { MentionPalette } from "./MentionPalette";
import { HistoryHintRow } from "./HistoryHintRow";
import { ComposerInputRow } from "./ComposerInputRow";
import type { Conversation, Attachment, Mode } from "../../shared/types";
import type { AppController } from "../app/AppContext";
import type { CodeSlashCommand } from "./code/code-slash-commands";
import type { ComposerField } from "./composer-field";
import type { DictationPhase } from "./voice/DictationButton";
import type { FileDropScope, FileDropState } from "./useFileDrop";
import type { HistoryHint } from "./prompt-history";
import type { HostInfo } from "../../shared/host";
import type { MentionMatch, MentionRange } from "./mention";
import type { MentionFile } from "../../shared/composer-api";
import type { PendingAttachment } from "./Attachments";
import type { ReviewComment } from "../changes/review-comments";
import type { SkillToken } from "./skill-tokens";

/** What ComposerCard needs from ComposerView.tsx. */
export interface ComposerBlockProps {
  active: Conversation | undefined;
  appContext: AppController | undefined;
  artifactOutput: "docs" | "slides" | "design" | "dashboard" | undefined;
  attachmentPicker: React.JSX.Element;
  attachments: Attachment[];
  bash: boolean;
  chooseSlash: (command: CodeSlashCommand) => void;
  codeHomeDraft: boolean;
  composer: React.RefObject<ComposerField | null>;
  conversation: boolean;
  dictation: {
    live: boolean;
    onLive(spoken: string): void;
    onTranscript(spoken: string): void;
    onCancel(): void;
  };
  dictationPhase: DictationPhase;
  draftIdentity: string;
  dropScope: FileDropScope;
  dropState: FileDropState;
  foldingSubmit: React.JSX.Element;
  frame: React.RefObject<HTMLDivElement | null>;
  hasDraft: boolean;
  history: {
    hint: HistoryHint | null;
    onKeyDown: (event: React.KeyboardEvent<ComposerField>) => boolean;
    reset: () => void;
  };
  host: HostInfo;
  inputRow: React.RefObject<HTMLDivElement | null>;
  interrupt: () => Promise<void>;
  mention: MentionMatch | null;
  mentionOpen: boolean;
  mentionTokens: MentionRange[];
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
  messageField: React.JSX.Element;
  micButton: React.JSX.Element;
  mode: Mode;
  multiline: boolean;
  pending: PendingAttachment[];
  pendingSlash: string | null;
  previewShown: boolean;
  promptPreview: string | null;
  report: (error: unknown) => void;
  reviewNotes: ReviewComment[];
  running: boolean;
  selectedSlash: number;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setCaret: React.Dispatch<React.SetStateAction<number>>;
  setSkillTokens: ((tokens: SkillToken[]) => void) | undefined;
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashSelected: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  skillRanges: SkillToken[];
  slashCommands: CodeSlashCommand[];
  slashOpen: boolean;
  slashQuery: string;
  slashTokenSelected: boolean;
  submit: (options?: { later?: boolean | undefined } | undefined) => void;
  submitButton: React.JSX.Element;
  text: string;
  toolbar: React.JSX.Element;
  trailingControls: React.RefObject<HTMLDivElement | null>;
  unifiedChat: boolean;
}

export function ComposerCard({
  active,
  appContext,
  artifactOutput,
  attachmentPicker,
  attachments,
  bash,
  chooseSlash,
  codeHomeDraft,
  composer,
  conversation,
  dictation,
  dictationPhase,
  draftIdentity,
  dropScope,
  dropState,
  foldingSubmit,
  frame,
  hasDraft,
  history,
  host,
  inputRow,
  interrupt,
  mention,
  mentionOpen,
  mentionTokens,
  mentions,
  messageField,
  micButton,
  mode,
  multiline,
  pending,
  pendingSlash,
  previewShown,
  promptPreview,
  report,
  reviewNotes,
  running,
  selectedSlash,
  setAttachments,
  setCaret,
  setSkillTokens,
  setSlashDismissed,
  setSlashSelected,
  setText,
  skillRanges,
  slashCommands,
  slashOpen,
  slashQuery,
  slashTokenSelected,
  submit,
  submitButton,
  text,
  toolbar,
  trailingControls,
  unifiedChat,
}: ComposerBlockProps) {
  return (
    <div
      ref={frame}
      className={`composer ${running ? "is-running" : ""} ${dropState === "on-target" ? "is-dropping" : ""}`}
    >
      {codeHomeDraft && <PixelMascot webDraft />}
      {reviewNotes.length > 0 && (
        <div className="review-comment-chips">
          {reviewNotes.map((note) => (
            <span
              key={note.id}
              className="review-comment-chip"
              title={note.text}
            >
              <span className="review-comment-badge">{t("Comment")}</span>
              <span className="review-comment-name" data-no-translate>
                {formatText("Review comment on {where}", {
                  where: commentWhere(note),
                })}
              </span>
              <button
                type="button"
                aria-label={t("Remove")}
                onClick={() =>
                  active && removeReviewComment(active.id, note.id)
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <AttachmentList
        showPaths={mode === "code"}
        attachments={attachments}
        pending={pending}
        restoreKey={draftIdentity}
        onRemove={(id) =>
          setAttachments((value) => value.filter((file) => file.id !== id))
        }
      >
        {!active &&
          mode === "code" &&
          appContext?.composerDraft.draftLinearIssue && (
            <Suspense fallback={null}>
              <LinearIssuePill
                issue={appContext.composerDraft.draftLinearIssue}
                onRemove={() => {
                  appContext.composerDraft.setDraftLinearIssue(undefined);
                  composer.current?.focus();
                }}
              />
            </Suspense>
          )}
      </AttachmentList>
      {slashOpen && (
        <CodeSlashPalette
          commands={slashCommands}
          query={slashQuery}
          selected={selectedSlash}
          onHover={setSlashSelected}
          onSelect={chooseSlash}
        />
      )}
      {mentionOpen && (
        <MentionPalette
          files={mentions.files}
          query={mention?.query ?? ""}
          selected={mentions.selected}
          loading={mentions.loading}
          onHover={mentions.setSelected}
          onSelect={mentions.choose}
        />
      )}
      <Suspense fallback={null}>
        <DropOverlay
          scope={dropScope}
          state={dropState}
          label={t("Drop files here")}
        />
      </Suspense>
      {history.hint && <HistoryHintRow hint={history.hint} />}
      <ComposerInputRow
        appContext={appContext}
        artifactOutput={artifactOutput}
        attachmentPicker={attachmentPicker}
        bash={bash}
        codeHomeDraft={codeHomeDraft}
        composer={composer}
        conversation={conversation}
        dictation={dictation}
        dictationPhase={dictationPhase}
        draftIdentity={draftIdentity}
        foldingSubmit={foldingSubmit}
        hasDraft={hasDraft}
        host={host}
        inputRow={inputRow}
        interrupt={interrupt}
        mentionTokens={mentionTokens}
        mentions={mentions}
        messageField={messageField}
        micButton={micButton}
        mode={mode}
        multiline={multiline}
        pendingSlash={pendingSlash}
        previewShown={previewShown}
        promptPreview={promptPreview}
        report={report}
        running={running}
        setCaret={setCaret}
        setSkillTokens={setSkillTokens}
        setSlashDismissed={setSlashDismissed}
        setSlashSelected={setSlashSelected}
        setText={setText}
        skillRanges={skillRanges}
        slashOpen={slashOpen}
        slashTokenSelected={slashTokenSelected}
        submit={submit}
        submitButton={submitButton}
        text={text}
        trailingControls={trailingControls}
        unifiedChat={unifiedChat}
      />
      {mode !== "code" && !conversation && toolbar}
    </div>
  );
}
