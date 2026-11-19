import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import { codeScratchWorkspaceRoot } from "./code-scratch-workspace";
import { realFolder } from "./workspace-trust";

type FilesCarried = {
  outcome: "copied" | "too_many" | "failed";
  copied: number;
  alreadyThere: number;
  notCopied: number;
};

type ScratchSource = { cwd: string; real: string };
type CarryResult = {
  filesCarried?: FilesCarried;
  scratchCarried?: Conversation["scratchCarried"];
};

const maxEntries = 5_000;
const maxFileBytes = 1024 ** 3;
const dependencies = new Set(["node_modules", ".venv", "vendor"]);
const settings = new Set([
  ".git",
  ".hg",
  ".sl",
  ".jj",
  ".bzr",
  "_darcs",
  ".svn",
  ".claude",
  ".codex",
  ".vscode",
  ".idea",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".husky",
  ".githooks",
  "githooks",
  ".lefthook",
  ".lefthook-local",
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".envrc",
  ".direnvrc",
  ".devcontainer.json",
  ".env",
  ".netrc",
  "_netrc",
  "profile.ps1",
  "head",
  "microsoft.powershell_profile.ps1",
  "microsoft.powershellise_profile.ps1",
  "microsoft.vscode_profile.ps1",
  "powershell.config.json",
]);
const hookConfig =
  /^(\.pre-commit-config\.ya?ml|\.?lefthook(-local)?\.(ya?ml|toml|json)|\.lintstagedrc(\..+)?|lint-staged\.config\..+|package\.ya?ml|\.huskyrc(\..+)?|husky\.config\..+|\.commitlintrc(\..+)?|commitlint\.config\..+|\.?nano-staged\.(json|[cm]?js))$/;
const envExamples = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
]);
const normalizedName = (name: string) =>
  name.toLowerCase().replace(/[. ]+$/, "");
const protectedName = (name: string) =>
  settings.has(name) ||
  hookConfig.test(name) ||
  /~\d/.test(name) ||
  (name.startsWith(".env.") && !envExamples.has(name));

function contains(root: string, directory: string) {
  const relative = path.relative(root, directory);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function departingScratch(
  cwd: string | undefined,
  target: string,
  workspace: string,
): ScratchSource | undefined {
  if (!cwd) return;
  const realWorkspace = realFolder(workspace);
  const real = realFolder(cwd);
  const scratch = codeScratchWorkspaceRoot(real, realWorkspace);
  if (!scratch || realFolder(scratch) !== scratch || contains(scratch, target))
    return;
  return { cwd, real };
}

async function entry(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
}

const emptyResult = (outcome: FilesCarried["outcome"]): FilesCarried => ({
  outcome,
  copied: 0,
  alreadyThere: 0,
  notCopied: 0,
});

export async function carryScratchFiles(
  source: ScratchSource,
  target: string,
  current: () => boolean,
): Promise<CarryResult> {
  const files: string[] = [];
  const left: string[] = [];
  const result = emptyResult("copied");
  let entries = 0;
  const record = (relative: string, count: "alreadyThere" | "notCopied") => {
    result[count]++;
    if (left.length <= 50) left.push(relative.split(path.sep).join("/"));
  };
  try {
    if (!(await entry(source.real))?.isDirectory())
      return { filesCarried: emptyResult("failed") };
    const home = realFolder(os.homedir());
    const protectedTarget =
      contains(target, home) ||
      target
        .split(path.sep)
        .some((name) => protectedName(normalizedName(name))) ||
      Boolean(await entry(path.join(target, "HEAD")));
    const dirs = [""];
    while (dirs.length && current()) {
      const dir = dirs.pop()!;
      const entriesHere = await fs
        .opendir(path.join(source.real, dir))
        .catch(() => undefined);
      if (!entriesHere) {
        if (!dir) return { filesCarried: emptyResult("failed") };
        record(dir, "notCopied");
        continue;
      }
      for await (const item of entriesHere) {
        if (++entries > maxEntries)
          return { filesCarried: emptyResult("too_many") };
        const relative = path.join(dir, item.name);
        const name = normalizedName(item.name);
        const destination = path.join(target, relative);
        if (
          protectedTarget ||
          protectedName(name) ||
          (item.isDirectory() && dependencies.has(name))
        ) {
          if (relative === ".claude" && item.isDirectory()) {
            const settingsOnly = await fs
              .readdir(path.join(source.real, relative))
              .catch(() => []);
            if (
              settingsOnly.length === 1 &&
              settingsOnly[0] === "settings.local.json"
            ) {
              if (left.length <= 50) left.push(relative);
              continue;
            }
          }
          record(relative, "notCopied");
          continue;
        }
        if (item.isDirectory()) {
          const existing = await entry(destination);
          if (
            existing &&
            (!existing.isDirectory() ||
              (await entry(path.join(destination, "HEAD"))))
          )
            record(relative, "notCopied");
          else dirs.push(relative);
        } else if (!item.isFile()) record(relative, "notCopied");
        else if (await entry(destination)) record(relative, "alreadyThere");
        else files.push(relative);
      }
    }
  } catch {
    return { filesCarried: emptyResult("failed") };
  }

  let remainingBytes = 2 * maxFileBytes;
  for (const relative of files) {
    if (!current()) break;
    const original = path.join(source.real, relative);
    const destination = path.join(target, relative);
    try {
      const stat = await entry(original);
      if (
        !stat?.isFile() ||
        stat.size > Math.min(maxFileBytes, remainingBytes)
      ) {
        record(relative, "notCopied");
        continue;
      }
      const parent = path.dirname(destination);
      await fs.mkdir(parent, { recursive: true });
      if ((await fs.realpath(parent)) !== parent) {
        record(relative, "notCopied");
        continue;
      }
      if (!current()) break;
      await fs.copyFile(original, destination, constants.COPYFILE_EXCL);
      result.copied++;
      remainingBytes -= stat.size;
    } catch (error) {
      record(
        relative,
        error instanceof Error && "code" in error && error.code === "EEXIST"
          ? "alreadyThere"
          : "notCopied",
      );
    }
  }
  const scratchCarried =
    result.copied && left.length <= 50 && left.every(Boolean)
      ? { from: [...new Set([source.cwd, source.real])], to: target, left }
      : undefined;
  return {
    ...(result.copied || result.alreadyThere || result.notCopied
      ? { filesCarried: result }
      : {}),
    ...(scratchCarried ? { scratchCarried } : {}),
  };
}
