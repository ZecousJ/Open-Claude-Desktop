import type { VoicePhase } from "../voice/useVoiceMode";

// Dictation takes priority over the owning voice session.
export function voicePlaceholder(dictation: string, voice: VoicePhase) {
  if (dictation === "requesting") return "Connecting...";
  if (dictation === "recording") return "Listening...";
  switch (voice) {
    case "starting":
      return "Connecting...";
    case "reconnecting":
      return "Reconnecting...";
    case "listening":
      return "Listening...";
    case "thinking":
      return "Processing...";
    case "speaking":
      return "Claudex is speaking...";
    default:
      return undefined;
  }
}
