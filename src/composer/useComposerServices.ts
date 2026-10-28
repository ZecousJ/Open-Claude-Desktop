import { useContext, useSyncExternalStore } from "react";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { VoiceAvailability } from "../../shared/voice-api";
import { AppContext } from "../app/AppContext";
import { modelCatalogStore } from "./model-catalog-store";

export function useModelCatalogState() {
  const app = useContext(AppContext);
  const store = modelCatalogStore(
    typeof window === "undefined" ? undefined : window.desktop,
    app?.accountId ?? "",
  );
  const state = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.serverSnapshot,
  );
  return { ...state, retry: store.retry };
}

/**
 * Whether the composer shows the microphone (availability read by C6's
 * src/voice/useVoiceAvailability): the administrator allows voice
 * and the service can transcribe now. Otherwise there is no button at all,
 * rather than one that only reports it is unavailable.
 */
export function dictationShown(
  policyVoice: boolean,
  voice: VoiceAvailability | null | undefined,
): voice is VoiceAvailability {
  return policyVoice && Boolean(voice?.transcription);
}

/** The administrator's model catalog; null without one (local accounts). */
export function useModelCatalog(): ModelCatalog | null {
  return useModelCatalogState().value ?? null;
}
