import { Suspense } from "react";
import { codeLiveLayout } from "./code-live-layout";
import {
  CodeOutputIntent,
  MentionMirror,
  SkillTokenMirror,
  BashModePill,
} from "./Composer";
import { ChatInput } from "./ChatInput";
import { WebCodeDraftActions } from "../code-home/WebCodeDraftActions";
import { plainEnterSends } from "./enter-key";
import { MoreSendOptions } from "./MoreSendOptions";
import type { AppController } from "../app/AppContext";
import type { ComposerField } from "./composer-field";
import type { DictationPhase } from "./voice/DictationButton";
import type { HostInfo } from "../../shared/host";
import type { MentionRange, MentionMatch } from "./mention";
import type { MentionFile } from "../../shared/composer-api";
import type { Mode } from "../../shared/types";
import type { SkillToken } from "./skill-tokens";

/** What ComposerInputRow needs from ComposerView.tsx. */
export interface ComposerInputRowProps {
  appContext: AppController | undefined;
  artifactOutput: "docs" | "slides" | "design" | "dashboard" | undefined;
  attachmentPicker: React.JSX.Element;
  bash: boolean;
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
  foldingSubmit: React.JSX.Element;
  hasDraft: boolean;
  host: HostInfo;
  inputRow: React.RefObject<HTMLDivElement | null>;
  interrupt: () => Promise<void>;
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
  pendingSlash: string | null;
  previewShown: boolean;
  promptPreview: string | null;
  report: (error: unknown) => void;
  running: boolean;
  setCaret: React.Dispatch<React.SetStateAction<number>>;
  setSkillTokens: ((tokens: SkillToken[]) => void) | undefined;
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashSelected: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  skillRanges: SkillToken[];
  slashOpen: boolean;
  slashTokenSelected: boolean;
  submit: (options?: { later?: boolean | undefined } | undefined) => void;
  submitButton: React.JSX.Element;
  text: string;
  trailingControls: React.RefObject<HTMLDivElement | null>;
  unifiedChat: boolean;
}

export function ComposerInputRow({
  appContext,
  artifactOutput,
  attachmentPicker,
  bash,
  codeHomeDraft,
  composer,
  conversation,
  dictation,
  dictationPhase,
  draftIdentity,
  foldingSubmit,
  hasDraft,
  host,
  inputRow,
  interrupt,
  mentionTokens,
  mentions,
  messageField,
  micButton,
  mode,
  multiline,
  pendingSlash,
  previewShown,
  promptPreview,
  report,
  running,
  setCaret,
  setSkillTokens,
  setSlashDismissed,
  setSlashSelected,
  setText,
  skillRanges,
  slashOpen,
  slashTokenSelected,
  submit,
  submitButton,
  text,
  trailingControls,
  unifiedChat,
}: ComposerInputRowProps) {
  return (
    <div
      className="composer-input-row"
      ref={inputRow}
      data-multiline={multiline || undefined}
    >
      {codeLiveLayout(mode, host, codeHomeDraft) && attachmentPicker}
      {artifactOutput && (
        <Suspense fallback={null}>
          <CodeOutputIntent
            kind={artifactOutput}
            onRemove={() => {
              appContext?.composerDraft.setDraftArtifactOutput(undefined);
              composer.current?.focus();
            }}
          />
        </Suspense>
      )}
      {mode === "code" && pendingSlash && (
        <span
          className="code-slash-token"
          data-selected={slashTokenSelected || undefined}
          aria-label={`/${pendingSlash}`}
        >
          <span className="code-slash-mark">/</span>
          {pendingSlash}
        </span>
      )}
      {slashOpen && text === "/" && (
        <span className="code-slash-ghost" aria-hidden="true">
          <span>/</span>
          <span>Type to filter</span>
        </span>
      )}
      {previewShown && (
        <p className="composer-prompt-preview" aria-hidden="true">
          {promptPreview}
        </p>
      )}
      {mode === "code" ? (
        <div className="composer-mention-field">
          {mentionTokens.length > 0 && (
            <Suspense fallback={null}>
              <MentionMirror
                text={text}
                ranges={mentionTokens}
                field={composer}
              />
            </Suspense>
          )}
          {messageField}
        </div>
      ) : unifiedChat ? (
        <div className="composer-mention-field composer-atomic-field">
          <ChatInput
            key={draftIdentity}
            identity={draftIdentity}
            scope={appContext?.controllerScope}
            field={composer}
            text={text}
            tokens={skillRanges}
            nativeProps={messageField.props}
            fallback={messageField}
            onDraft={(value, tokens) => {
              setText(value);
              setSkillTokens?.(tokens);
              setSlashSelected(0);
              setSlashDismissed(false);
              mentions.setSelected(0);
            }}
            onSelection={setCaret}
            onError={report}
          />
        </div>
      ) : (
        <div className="composer-mention-field composer-skill-field">
          {skillRanges.length > 0 && (
            <Suspense fallback={null}>
              <SkillTokenMirror
                text={text}
                tokens={skillRanges}
                field={composer}
              />
            </Suspense>
          )}
          {messageField}
        </div>
      )}
      {bash && (
        <Suspense fallback={null}>
          <BashModePill />
        </Suspense>
      )}
      {codeLiveLayout(mode, host, codeHomeDraft) ? (
        <WebCodeDraftActions
          hasDraft={hasDraft || running}
          dictationPhase={dictationPhase}
          live={dictation.live}
          microphone={micButton}
          submit={submitButton}
        />
      ) : mode === "code" ? (
        submitButton
      ) : null}
      {mode === "code" &&
        running &&
        hasDraft &&
        !plainEnterSends(host.kind === "desktop") && (
          // On a touch screen a mid-turn Send carries More send options: Queue
          // for later, then Stop.
          <MoreSendOptions
            canQueue={!bash}
            onQueue={() => submit({ later: true })}
            onStop={() => void interrupt().catch(report)}
          />
        )}
      {conversation && (
        <div className="conversation-input-actions" ref={trailingControls}>
          {foldingSubmit}
        </div>
      )}
    </div>
  );
}
