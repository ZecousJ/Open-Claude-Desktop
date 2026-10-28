import type { Conversation, Settings } from "./types";

export const codePermissionModes = [
  "auto",
  "manual",
  "acceptEdits",
  "plan",
  "bypass",
] as const;
export type CodePermissionMode = (typeof codePermissionModes)[number];
export type CodePermissionPatch = Pick<
  Settings,
  "codeSandbox" | "autoAcceptEdits" | "codePlanMode"
> &
  Pick<Settings, "bypassFolders">;

/** Session overrides do not replace account-level trust or bypass eligibility. */
export function codeSessionSettings<T extends Settings>(
  settings: T,
  mode?: CodePermissionMode,
): T {
  if (!mode) return settings;
  return {
    ...settings,
    codeSandbox:
      mode === "bypass"
        ? "danger-full-access"
        : mode === "manual" || mode === "plan"
          ? "read-only"
          : "workspace-write",
    codePlanMode: mode === "plan",
    autoAcceptEdits: mode === "acceptEdits",
  };
}

export function codePermissionModeOf(
  settings: Pick<Settings, "codeSandbox" | "autoAcceptEdits" | "codePlanMode">,
): CodePermissionMode {
  return settings.codePlanMode
    ? "plan"
    : settings.codeSandbox === "danger-full-access"
      ? "bypass"
      : settings.codeSandbox === "read-only"
        ? "manual"
        : settings.autoAcceptEdits
          ? "acceptEdits"
          : "auto";
}

/** A permission chosen during a running turn applies to the following turn. */
export function codeExecutionSettings(
  settings: Settings,
  conversation: Conversation,
): Settings {
  if (conversation.mode !== "code") return settings;
  const turn = conversation.turns.at(-1);
  const mode =
    (turn?.status === "inProgress" ? turn.codePermissionMode : undefined) ??
    conversation.codePermissionMode;
  return codeSessionSettings(settings, mode);
}
