/**
 * Dictation (package C6). The composer's microphone shows only while
 * `voiceAvailability()` reports dictation as available. Read aloud was
 * removed (owner decision 19). Published fields keep their types; new ones
 * are added as optional fields.
 *
 * The window records 16 kHz mono pcm_s16le and streams it in chunks:
 * `startDictation()`, then `dictationAudio()` about every 100 ms (each reply
 * carries the transcript so far), then `finishDictation()` for the whole
 * transcript, or `cancelDictation()`.
 */
import { bridgeMethods } from "./bridge-methods";
export const voiceOff =
  "Your administrator has turned off voice and dictation.";

export interface VoiceAvailability {
  /** Dictation into the composer can be used now. */
  transcription: boolean;
  /** Largest recording file the service accepts; null when it names none. */
  maxTranscriptionBytes: number | null;
  /** Longest recording, in seconds; null when the service names none. */
  maxSeconds: number | null;
  /** The service sends partial transcripts while the person speaks. */
  streaming?: boolean;
}

/** Audio format of `dictationAudio` chunks. */
export const dictationAudioFormat = {
  sampleRate: 16_000,
  channels: 1,
  /** pcm_s16le */
  bytesPerSample: 2,
} as const;
/** Largest chunk `dictationAudio` takes (about two seconds). */
export const maxDictationChunkBytes = 64 * 1024;
/** Recording limit. */
export const defaultDictationSeconds = 600;
/** Credential ceiling. */
export const maxDictationSeconds = 43_200;

/** Dictation stops itself after this long without a new word. */
export const dictationSilenceSeconds = 60;

export function dictationRecordingSeconds(maxSeconds: number | null) {
  return typeof maxSeconds !== "number" || maxSeconds <= 0
    ? defaultDictationSeconds
    : Math.max(maxSeconds - 15, 15);
}

export interface DictationStart {
  sessionId: string;
  /** Partial transcripts arrive while recording (the Claudex service). */
  streaming: boolean;
  /** The recording stops by itself after this many seconds. */
  maxSeconds: number;
}

export interface DictationStartOptions {
  /** Omitted for automatic language detection. */
  language?: string;
}

/** Same language-tag boundary as the service's realtime relay. */
export function dictationStartOptions(value?: unknown): DictationStartOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid dictation language.");
  const language = (value as DictationStartOptions).language;
  if (language === undefined || language === "") return {};
  if (
    typeof language !== "string" ||
    language.trim() !== language ||
    !/^[A-Za-z]{2,8}([-_][A-Za-z0-9]{1,8}){0,2}$/.test(language)
  )
    throw Error("Invalid dictation language.");
  return { language: language.replaceAll("_", "-") };
}

/** The transcript so far: finished segments and the one still being spoken. */
export interface DictationProgress {
  text: string;
  partial: string;
}

const cjk =
  /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
/** Joins two pieces of spoken text: a space between words, none around CJK text. */
export function joinSpoken(before: string, after: string) {
  const left = before.trimEnd(),
    right = after.trimStart();
  if (!left) return right;
  if (!right) return left;
  return cjk.test(left.at(-1)!) || cjk.test(right[0])
    ? left + right
    : `${left} ${right}`;
}

export interface VoiceAPI {
  voiceAvailability(): Promise<VoiceAvailability>;
  requestMicrophone(): Promise<boolean>;
  openMicrophoneSettings(): Promise<void>;
  startDictation(options?: DictationStartOptions): Promise<DictationStart>;
  dictationAudio(
    sessionId: string,
    pcm: Uint8Array,
  ): Promise<DictationProgress>;
  /** Resolves to the whole transcript ("" when nothing was heard). */
  finishDictation(sessionId: string): Promise<string>;
  cancelDictation(sessionId: string): Promise<void>;
}

export const voiceMethods = bridgeMethods<VoiceAPI>({
  voiceAvailability: true,
  requestMicrophone: true,
  openMicrophoneSettings: true,
  startDictation: true,
  dictationAudio: true,
  finishDictation: true,
  cancelDictation: true,
});
