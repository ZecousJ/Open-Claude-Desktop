import { joinSpoken } from "../../shared/voice-api";
import { selectedDictationLanguage } from "./dictation-language";

/**
 * Speech recognition by the browser itself, for where Claudex's service has no
 * transcription. It is off until the person turns it on (Settings → General →
 * Voice): Chrome and Edge send the audio to their own speech service (Google's
 * or Microsoft's), which Claudex's service does not, so it is never a silent
 * fallback.
 */
const key = "claudex.speech.recognition";
const memory = new Map<string, string>();

type Ctor = new () => any;
const constructor = (): Ctor | undefined =>
  typeof window === "undefined"
    ? undefined
    : ((window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition);

/** Whether this browser has speech recognition to offer. */
export const browserRecognitionAvailable = () => Boolean(constructor());

/** Whether the person chose it (off by default). */
export function browserRecognitionChosen() {
  try {
    return (localStorage.getItem(key) ?? memory.get(key)) === "on";
  } catch {
    return memory.get(key) === "on";
  }
}
export function chooseBrowserRecognition(on: boolean) {
  memory.set(key, on ? "on" : "off");
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // Blocked storage keeps the choice for this page only.
  }
  dispatchEvent(new Event("claudex-speech-preferences"));
}

/** What to tell the person for a recognition error code. */
export function recognitionErrorText(code: string): string | undefined {
  switch (code) {
    case "no-speech":
    case "aborted":
      return undefined;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was not granted.";
    case "audio-capture":
      return "No microphone found. Connect a microphone and try again.";
    case "network":
      return "The browser's speech service couldn't be reached.";
    default:
      return "Speech recognition failed.";
  }
}

export interface Recognizer {
  /** Stops listening; `onEnd` follows with the whole text. */
  stop(): void;
  /** Stops at once and drops what was heard. */
  abort(): void;
}

/** The language recognition listens for: the chosen one, else the browser's. */
export const recognitionLanguage = () =>
  selectedDictationLanguage() ||
  (typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US");

/** Starts listening; throws when the browser has no recognition. */
export function startRecognition(handlers: {
  onText: (text: string) => void;
  onEnd: (text: string) => void;
  onError: (error: Error) => void;
}): Recognizer {
  const Recognition = constructor();
  if (!Recognition) throw new Error("This browser can't recognise speech.");
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = recognitionLanguage();
  let done = "";
  let latest = "";
  let dropped = false;
  recognition.onresult = (event: any) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) done = joinSpoken(done, result[0].transcript);
      else interim += result[0].transcript;
    }
    latest = joinSpoken(done, interim);
    handlers.onText(latest);
  };
  recognition.onerror = (event: any) => {
    const text = recognitionErrorText(String(event.error));
    if (text)
      handlers.onError(
        Object.assign(new Error(text), {
          code:
            event.error === "audio-capture" ? "mic_lost" : String(event.error),
        }),
      );
  };
  recognition.onend = () => {
    if (!dropped) handlers.onEnd(latest || done);
  };
  recognition.start();
  return {
    stop: () => recognition.stop(),
    abort: () => {
      dropped = true;
      recognition.abort();
    },
  };
}
