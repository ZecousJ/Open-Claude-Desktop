import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiffScope } from "../../shared/types";
import {
  defaultBaseBranch,
  mainRemote,
  resolveBase,
  validBranchName,
  validCommitId,
} from "../git/git-scope";
import { gitEnvironment, safeGitConfig } from "../git/working-tree";

/**
 * An image file's two sides for the Changes panel's View image: the version
 * before the change and the one after, as `data:` URLs, read from the
 * repository (or, for the working tree, the file itself). Missing on a side
 * that has no such file; refused past 10 MB.
 */
export const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};
const maxBytes = 10 * 1024 * 1024;

export function imageType(file: string) {
  return imageTypes[path.extname(file).slice(1).toLowerCase()];
}

const gitBytes = (cwd: string, args: string[]) =>
  new Promise<Buffer | null>((resolve) => {
    execFile(
      "git",
      [...safeGitConfig, ...args],
      {
        cwd,
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: maxBytes + 1,
        windowsHide: true,
        env: { ...process.env, ...gitEnvironment },
      },
      (error, stdout) => resolve(error ? null : (stdout as Buffer)),
    );
  });
const gitText = async (cwd: string, args: string[]) =>
  (await gitBytes(cwd, args))?.toString("utf8").trim() ?? "";

/** The repository's top folder for a folder inside it; "" outside one. */
export const workspaceTop = (cwd: string) =>
  gitText(cwd, ["rev-parse", "--show-toplevel"]);

const dataUrl = (bytes: Buffer | null, type: string) =>
  bytes && bytes.length <= maxBytes
    ? `data:${type};base64,${bytes.toString("base64")}`
    : null;

export async function changedImage(
  cwd: string,
  file: string,
  side: "before" | "after",
  scope: DiffScope = { kind: "branch" },
): Promise<string | null> {
  const type = imageType(file);
  const relative = file.replace(/\\/g, "/");
  if (
    !type ||
    path.isAbsolute(relative) ||
    relative.split("/").some((part) => part === ".." || part === "")
  )
    return null;
  const top = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const at = (ref: string) => gitBytes(top, ["show", `${ref}:${relative}`]);
  if (scope.kind === "commit") {
    if (!validCommitId(scope.sha)) return null;
    return dataUrl(
      await at(side === "after" ? scope.sha : `${scope.sha}^`),
      type,
    );
  }
  if (side === "after") {
    // The working tree's file, never through a link that leaves the folder.
    const target = path.resolve(top, relative);
    try {
      const real = fs.realpathSync(target);
      if (path.relative(fs.realpathSync(top), real).startsWith(".."))
        return null;
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      return dataUrl(fs.readFileSync(real), type);
    } catch {
      return null;
    }
  }
  if (scope.kind === "uncommitted") return dataUrl(await at("HEAD"), type);
  // The branch: where it left its base.
  const run = async (dir: string, args: string[]) => {
    const out = await gitBytes(dir, args);
    if (out === null) throw Error("git failed");
    return out.toString("utf8");
  };
  const remote = await mainRemote(run, top);
  const base = validBranchName(scope.base)
    ? scope.base
    : await defaultBaseBranch(run, top, remote, undefined);
  const baseRef = base ? await resolveBase(run, top, remote, base) : undefined;
  const mergeBase = baseRef
    ? await gitText(top, ["merge-base", baseRef, "HEAD"])
    : "";
  return dataUrl(await at(mergeBase || "HEAD"), type);
}
