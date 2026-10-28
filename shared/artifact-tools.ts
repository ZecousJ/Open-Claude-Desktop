export interface ArtifactToolGroup {
  server: string;
  tools: string[];
}

export interface ArtifactToolCall {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  groups?: ArtifactToolGroup[];
}

export interface ArtifactToolRequest extends ArtifactToolCall {
  id: string;
  groups: ArtifactToolGroup[];
  permitted: boolean;
}

export const artifactToolMessage = "claudex-artifact-tool";
export const artifactToolResult = "claudex-artifact-tool-result";

export function artifactToolArguments(input: Record<string, unknown>) {
  return JSON.stringify(input, null, 2).replace(
    /[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
    (character) =>
      character === "\n"
        ? character
        : `\\u${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

// : AM, zM and BM.
export function artifactToolDisplay(value: string, limit?: number) {
  const escaped = value.replace(
    /[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
    (character) =>
      `\\u${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
  );
  const points = [...escaped];
  return limit && points.length > limit
    ? points.slice(0, limit - 1).join("") + "…"
    : escaped;
}

export function artifactToolPreview(input: Record<string, unknown>) {
  const full = artifactToolArguments(input);
  const shortened = full.length > 20_000;
  const cutoff = /[\uD800-\uDBFF]/.test(full[1999] ?? "") ? 1999 : 2000;
  const entries = Object.entries(input);
  const names = new Set<string>();
  const rows: { label: string; text: string; stacked: boolean }[] = [];
  let readable = !shortened && entries.length > 0 && entries.length <= 64;
  for (const [key, value] of entries) {
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split("_")
      .join(" ")
      .toLowerCase();
    const label = words.charAt(0).toUpperCase() + words.slice(1);
    const identity = label
      .toLowerCase()
      .replace(/ /g, "")
      .replace(/0/g, "o")
      .replace(/[1i]/g, "l")
      .replace(/cl/g, "d")
      .replace(/rn/g, "m")
      .replace(/vv/g, "w");
    if (
      !/^[a-z][a-z0-9]*(?:(?:_[a-z0-9]+)*|(?:[A-Z][a-z0-9]+)*)$/.test(key) ||
      label.length > 32 ||
      label.split(" ").length > 4 ||
      names.has(identity)
    )
      readable = false;
    names.add(identity);
    const raw = JSON.stringify(value, null, 2);
    if (raw === undefined) {
      readable = false;
      continue;
    }
    const serialized = raw.replace(
      /[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
      (character) =>
        character === "\n" ? character : artifactToolDisplay(character),
    );
    rows.push({
      label,
      text: serialized,
      stacked:
        serialized.includes("\n") ||
        serialized.length > 45 ||
        label.length > 18,
    });
  }
  return {
    text: shortened ? full.slice(0, cutoff) : full,
    shortened,
    rows: readable ? rows : null,
  };
}

export function artifactToolIdentity(artifact: {
  id: string;
  libraryId?: string;
  conversationId?: string;
  sourcePath?: string;
}) {
  return artifact.libraryId
    ? JSON.stringify(["library", artifact.libraryId])
    : JSON.stringify([
        artifact.conversationId ?? "",
        artifact.sourcePath ?? artifact.id,
      ]);
}
