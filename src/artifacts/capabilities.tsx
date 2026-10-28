import { createContext, useContext } from "react";

/**
 * Settings → Capabilities as the transcript and artifact previews read them
 * (App provides the account's values; optional Artifacts defaults to existing behavior).
 */
export interface CapabilityPreferences {
  /** New HTML replies may become artifact cards; omitted keeps existing callers compatible. */
  artifacts?: boolean;
  /** Artifacts may call `window.claude.complete`. */
  aiArtifacts: boolean;
  /** `visualization` blocks are drawn in the reply. */
  inlineVisualizations: boolean;
}

export const Capabilities = createContext<CapabilityPreferences>({
  aiArtifacts: false,
  inlineVisualizations: false,
});

export const useCapabilities = () => useContext(Capabilities);
