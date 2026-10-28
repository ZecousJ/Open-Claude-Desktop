import { type RefObject, type Dispatch, type SetStateAction } from "react";
import {
  DictationButton,
  type DictationPhase,
} from "../composer/voice/DictationButton";
import { usePolicy } from "../policy/PolicyContext";
import { useSpeechEngine } from "./useSpeechEngine";
import { useDictationDraft } from "./useDictationDraft";
import { useVoiceAvailability } from "./useVoiceAvailability";
import "./comment-dictation.css";

/** Pinned comment accessory. */
export function CommentDictation({
  text,
  setText,
  field,
  contextKey,
  onPhase,
  onError,
  onSubmit,
}: {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  field: RefObject<HTMLTextAreaElement | null>;
  contextKey: string;
  onPhase: (phase: DictationPhase) => void;
  onError: (error: unknown) => void;
  onSubmit: (spoken: string) => void;
}) {
  const policy = usePolicy();
  const voice = useVoiceAvailability(contextKey);
  const engine = useSpeechEngine(policy.voice, voice);
  const draft = useDictationDraft(text, setText, contextKey, () =>
    field.current?.focus(),
  );
  if (!engine) return null;
  const platform = /Mac/.test(navigator.platform)
    ? "darwin"
    : /Win/.test(navigator.platform)
      ? "win32"
      : "linux";
  return (
    <DictationButton
      comment
      canStart={!text.trim()}
      engine={engine}
      maxSeconds={voice?.maxSeconds ?? null}
      contextKey={contextKey}
      platform={platform}
      onPhase={onPhase}
      onError={onError}
      field={field}
      onSubmit={onSubmit}
      {...draft}
    />
  );
}
