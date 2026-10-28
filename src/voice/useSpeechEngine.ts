import { useSyncExternalStore } from "react";
import type { VoiceAvailability } from "../../shared/voice-api";
import {
  browserRecognitionAvailable,
  browserRecognitionChosen,
} from "./browser-recognition";

export type SpeechEngine = "service" | "browser";

const subscribe = (listener: () => void) => {
  addEventListener("claudex-speech-preferences", listener);
  return () => removeEventListener("claudex-speech-preferences", listener);
};

/**
 * What turns speech into text now: Claudex's service when it transcribes; else
 * the browser's own recognition when the person chose it (Settings → General →
 * Voice) and the administrator allows voice; else nothing.
 */
export function speechEngineFor(
  policyVoice: boolean,
  voice: VoiceAvailability | undefined,
  browserChosen: boolean,
  browserAvailable: boolean,
): SpeechEngine | undefined {
  if (!policyVoice) return undefined;
  if (voice?.transcription) return "service";
  return browserChosen && browserAvailable ? "browser" : undefined;
}

export function useSpeechEngine(
  policyVoice: boolean,
  voice: VoiceAvailability | undefined,
) {
  const chosen = useSyncExternalStore(
    subscribe,
    browserRecognitionChosen,
    () => false,
  );
  return speechEngineFor(
    policyVoice,
    voice,
    chosen,
    browserRecognitionAvailable(),
  );
}
