import { parseUnifiedDiff } from "../../shared/diff-model";

const fileStatus: Record<string, string> = {
  A: "added",
  D: "removed",
  R: "renamed",
  C: "copied",
};

export function parseDiffNameStatus(output: string) {
  const fields = output.split("\0");
  const files: { path: string; status: string; previousPath?: string }[] = [];
  for (let i = 0; fields[i];) {
    const code = fields[i++][0];
    const status = fileStatus[code] ?? "modified";
    const first = fields[i++];
    if (code === "R" || code === "C")
      files.push({ path: fields[i++], status, previousPath: first });
    else files.push({ path: first, status });
  }
  return files;
}

export function parseDiffNumstat(output: string) {
  const fields = output.split("\0");
  const byPath = new Map<
    string,
    { added: number; removed: number; isBinary: boolean }
  >();
  for (let i = 0; fields[i];) {
    const row = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i++]);
    if (!row) continue;
    const [, added, removed, filename] = row;
    if (!filename) i++;
    const path = filename || fields[i++];
    byPath.set(path, {
      added: Number(added) || 0,
      removed: Number(removed) || 0,
      isBinary: added === "-",
    });
  }
  return byPath;
}
export function parseGitPatches(output: string) {
  return output.split(/(?=^diff --git )/m).flatMap((patch) => {
    const [file] = parseUnifiedDiff(patch, "", { wordChanges: false });
    return file?.path ? [{ file, patch }] : [];
  });
}
