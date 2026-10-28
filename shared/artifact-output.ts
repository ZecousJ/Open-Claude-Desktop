/**
 * Code's start intent. Selecting it creates no artifact or message; the first
 * send creates ordinary files.
 */
export const artifactOutputKinds = [
  "docs",
  "slides",
  "design",
  "dashboard",
] as const;
export type ArtifactOutputKind = (typeof artifactOutputKinds)[number];
export function artifactOutputInstructions(
  kind: ArtifactOutputKind | undefined,
): string | undefined {
  if (!kind || !artifactOutputKinds.includes(kind)) return;
  const output: Record<ArtifactOutputKind, string> = {
    docs: "a standalone document in an appropriate editable document format",
    slides: "a presentation with distinct slides",
    design: "a visual design or interactive page",
    dashboard: "an interactive dashboard",
  };
  return `The user selected ${output[kind]} as this session's output. Create the actual requested artifact as files in the session workspace using your file tools. Use a descriptive filename and the user's requested format. Preserve existing user files. The app opens generated files as artifacts; do not merely describe an artifact or repeat its full source in the reply. HTML and React previews are sandboxed without network access: keep their scripts, styles and data self-contained.`;
}
