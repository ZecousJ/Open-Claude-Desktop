import fs from "node:fs";
import path from "node:path";
import type { RewindChange } from "../../shared/rewind-files";
import { rewindPreview } from "../../shared/rewind-files";
import { reverseDiff } from "./rewind-files";

export function rewindCodeFiles(
  changes: readonly RewindChange[],
  cwd: string,
  dryRun: boolean,
) {
  const pending = new Map<string, string | null>();
  const originals = new Map<string, string | null>();
  const read = (name: string) => {
    const file = path.resolve(cwd, name);
    if (!originals.has(file)) {
      const stat = fs.existsSync(file) ? fs.lstatSync(file) : undefined;
      if (stat && !stat.isFile())
        throw Error(`Cannot restore ${name}: it is not a regular file.`);
      const value = stat ? fs.readFileSync(file, "utf8") : null;
      originals.set(file, value);
      pending.set(file, value);
    }
    return { file, text: pending.get(file) ?? null };
  };
  try {
    for (const change of [...changes].reverse()) {
      const original = read(change.path);
      if (change.kind === "add") {
        if (original.text !== change.diff)
          throw Error(`Cannot restore ${change.path}: its contents changed.`);
        pending.set(original.file, null);
      } else if (change.kind === "delete") {
        if (original.text !== null)
          throw Error(
            `Cannot restore ${change.path}: the file already exists.`,
          );
        pending.set(original.file, change.diff);
      } else {
        const current = change.movePath ? read(change.movePath) : original;
        const restored =
          current.text === null
            ? undefined
            : reverseDiff(current.text, change.diff);
        if (restored === undefined)
          throw Error(
            `Cannot restore ${current.file}: its patch no longer applies.`,
          );
        if (current.file !== original.file && original.text !== null)
          throw Error(
            `Cannot restore ${change.path}: the original name already exists.`,
          );
        pending.set(original.file, restored);
        if (current.file !== original.file) pending.set(current.file, null);
      }
    }
    if (!dryRun) {
      const written: string[] = [];
      try {
        for (const [file, text] of pending) {
          if (text === originals.get(file)) continue;
          written.push(file);
          if (text === null) fs.rmSync(file);
          else {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text);
          }
        }
      } catch (error) {
        for (const file of written.reverse()) {
          const text = originals.get(file);
          if (text === null) fs.rmSync(file, { force: true });
          else if (text !== undefined) fs.writeFileSync(file, text);
        }
        throw error;
      }
    }
    return { canRewind: true, ...rewindPreview(changes) };
  } catch (error) {
    return {
      canRewind: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
