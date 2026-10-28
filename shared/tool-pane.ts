export const toolPaneKinds = [
  "background",
  "changes",
  "files",
  "browser",
  "ios-simulator",
  "android-emulator",
  "terminal",
  "runs",
  "session",
  "pr",
  "widget",
  "plan",
  "agent",
  "artifact",
] as const;
export type ToolPaneKind = (typeof toolPaneKinds)[number];

export function isToolPaneKind(value: unknown): value is ToolPaneKind {
  return (
    typeof value === "string" &&
    (toolPaneKinds as readonly string[]).includes(value)
  );
}
