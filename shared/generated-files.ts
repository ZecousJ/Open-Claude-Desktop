import type { GeneratedFile, Turn } from "./types";

/** Only the selected conversation path participates; saved inactive branches never leak in. */
export function latestGeneratedFiles(
  turns: Turn[],
): Map<string, GeneratedFile> {
  const files = new Map<string, GeneratedFile>();
  for (const turn of turns)
    for (const item of turn.items)
      for (const file of item.generatedFiles ?? []) {
        if (file.previousPath && file.previousPath !== file.path)
          files.set(file.previousPath, {
            ...file,
            path: file.previousPath,
            state: "deleted",
            content: undefined,
            error: "The file was moved.",
          });
        files.set(
          file.path,
          file.capturedAt === undefined
            ? { ...file, capturedAt: turn.createdAt }
            : file,
        );
      }
  return files;
}
