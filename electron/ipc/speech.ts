import type { AppContext, IpcHandle } from "../app/app-context";
import { DictationSessions, voiceAvailability } from "../voice/dictation";

/**
 * Voice availability and dictation sessions (package C6). The microphone
 * permission is in `transcription.ts`. Read aloud was removed (owner
 * decision 19).
 */
export function registerSpeechHandlers(handle: IpcHandle, ctx: AppContext) {
  const sessions = new DictationSessions(ctx);
  handle("voiceAvailability", () => voiceAvailability(ctx));
  handle("startDictation", (options?: unknown) => sessions.start(options));
  handle("dictationAudio", (sessionId: unknown, pcm: unknown) =>
    sessions.audio(sessionId, pcm),
  );
  handle("finishDictation", (sessionId: unknown) => sessions.finish(sessionId));
  handle("cancelDictation", (sessionId: unknown) => sessions.cancel(sessionId));
}
