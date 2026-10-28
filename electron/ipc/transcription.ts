import { shell, systemPreferences } from "electron";
import type { Store } from "../store/store";
import type { RequestLimits } from "../../server/operator-limits";
import { voiceOff } from "../../shared/voice-api";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
interface Context {
  readonly store: Store;
  readonly profileRoot: string;
  readonly vaultRoot: string;
  readonly vaultKey: string;
  readonly serviceScript: string;
  limits(): RequestLimits;
  /** Whether the administrator allows dictation and voice. */
  voiceAllowed(): boolean;
}

/**
 * The operating system's microphone permission for dictation (package C6).
 * The dictation sessions are in `speech.ts`, which gets the whole
 * AppContext (the remote account's key and bootstrap).
 */
export function registerTranscriptionHandlers(
  handle: Handle,
  context: Context,
) {
  handle("openMicrophoneSettings", async () => {
    if (process.platform === "darwin")
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
    else if (process.platform === "win32")
      await shell.openExternal("ms-settings:privacy-microphone");
  });
  handle("requestMicrophone", async () => {
    if (!context.voiceAllowed()) throw Error(voiceOff);
    if (process.platform === "darwin")
      return systemPreferences.askForMediaAccess("microphone");
    return !["denied", "restricted"].includes(
      systemPreferences.getMediaAccessStatus("microphone"),
    );
  });
}
