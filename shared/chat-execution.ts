import type { Mode, Settings } from "./types";
import { preference } from "./settings-extras";

/** Chat's file sandbox is independent of Code and Cowork workspaces. */
export function chatExecutionEnabled(settings: Settings, mode: Mode) {
  return mode !== "chat" || preference(settings, "chatExecution");
}

/** Artifacts stay available while Chat can create files (O16 :1057–1093). */
export function chatArtifactsEnabled(settings: Settings) {
  return (
    preference(settings, "chatExecution") || preference(settings, "artifacts")
  );
}

/** Native runtime removes shell, patch and image/file tools when no environment is selected. */
export function chatExecutionEnvironments(
  settings: Settings,
  mode: Mode,
  cwd?: string,
) {
  return mode === "chat"
    ? {
        environments: chatExecutionEnabled(settings, mode)
          ? [{ environmentId: "local", cwd }]
          : [],
      }
    : {};
}
