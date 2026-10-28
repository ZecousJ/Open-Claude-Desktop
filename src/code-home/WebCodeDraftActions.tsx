import type { ReactNode } from "react";
import type { DictationPhase } from "../composer/voice/DictationButton";

/** Permission and transcription phases keep the microphone's recorder alive. */
export function WebCodeDraftActions({
  hasDraft,
  dictationPhase,
  live,
  microphone,
  submit,
}: {
  hasDraft: boolean;
  dictationPhase: DictationPhase;
  live: boolean;
  microphone: ReactNode;
  submit: ReactNode;
}) {
  const recording = dictationPhase !== "idle" || live;
  return (
    <>
      {(!hasDraft || recording) && (
        <div className="web-code-draft-microphone">{microphone}</div>
      )}
      {hasDraft && !recording && submit}
    </>
  );
}
