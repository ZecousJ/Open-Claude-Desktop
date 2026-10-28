import { useEffect, useState } from "react";
import type { VoiceAvailability } from "../../shared/voice-api";

/**
 * Whether dictation can be used now (package C6); undefined until known.
 * Read again when the service's offer (bootstrap) or the policy changes.
 */
export function useVoiceAvailability(providerId: string) {
  const [voice, setVoice] = useState<VoiceAvailability>();
  useEffect(() => {
    // A host without the desktop bridge (the phone apps' conversation
    // surface) has no dictation here: the answer stays unknown.
    const desktop = (window as { desktop?: Window["desktop"] }).desktop;
    if (!desktop?.voiceAvailability) return;
    let current = true;
    const load = () =>
      void desktop
        .voiceAvailability()
        .then((value) => current && setVoice(value))
        .catch(() => current && setVoice(undefined));
    load();
    const unsubscribe = desktop.onEvent((event) => {
      if (event.type === "service-changed" || event.type === "policy") load();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [providerId]);
  return voice;
}
