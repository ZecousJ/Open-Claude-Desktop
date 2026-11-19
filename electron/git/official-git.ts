/** Read-only Git data in the recovered desktop renderer's native contract. */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  gitImageAtRevision,
  imageTypes,
  maxImageBytes,
} from "../artifacts/changed-image";
import type { WorkspaceFs } from "../workspace/workspace-fs";
import {
  emptyGitTree,
  isTransportError,
  localWorkingTree,
  type GitRunner,
} from "./working-tree";
import { ask } from "./git-scope";
import {
  parseDiffNameStatus,
  parseDiffNumstat,
  parseGitPatches,
} from "./git-diff-metadata";

const MAX_TEXT_BYTES = 2_000_000;
const MAX_INLINE_FILES = 300;
const MAX_INLINE_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 5 * MAX_INLINE_BYTES;
const MAX_LAZY_TRACKED_FILES = 1000;
const MAX_PATCHLESS_TRACKED_FILES = 200;
const MAX_UNTRACKED_READ_FILES = 200;
const MAX_UNTRACKED_FILES = 2 * MAX_UNTRACKED_READ_FILES;
const MAX_UNTRACKED_READ_BYTES = 1024 * 1024;
const ref = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (s) =>
      !s.startsWith("-") && !/[\s\0:~^?*\[\\]/.test(s) && !s.includes(".."),
  );
const file = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (s) =>
      !s.includes("\0") &&
      !s.includes("\\") &&
      !path.posix.isAbsolute(s) &&
      !s.split("/").some((p) => p === ".." || p === ".git") &&
      !/^[A-Za-z]:/.test(s),
  );
const common = { cwd: z.string().min(1).max(4096) };
export const officialGitRequest = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("state") }),
  z.object({ ...common, kind: z.literal("info") }),
  z.object({ ...common, kind: z.literal("branches") }),
  z.object({ ...common, kind: z.literal("changes") }),
  z.object({ ...common, kind: z.literal("workingTreeStatus") }),
  z.object({
    ...common,
    kind: z.literal("diff"),
    base: ref,
    head: ref.optional(),
    includePatches: z.boolean().optional(),
    inlinePatchesMaxChangedLines: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("stats"),
    base: ref,
    head: ref.optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("commits"),
    base: ref,
    head: ref.optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("commit"),
    sha: z.string().regex(/^[a-f0-9]{4,64}$/i),
  }),
  z.object({
    ...common,
    kind: z.literal("content"),
    base: ref,
    file,
    previous: file.optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("patch"),
    base: ref,
    file,
    previous: file.optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("image"),
    rev: ref.optional(),
    file,
  }),
]);
export type OfficialGitRequest = z.infer<typeof officialGitRequest>;
export interface OfficialGitRow {
  cwd: string;
  branch?: string;
  conflicted: boolean;
  ahead?: number;
  behind?: number;
}

async function resolve(
  git: GitRunner,
  top: string,
  name: string,
  object: "commit" | "tree" = "commit",
) {
  return (
    await git(
      top,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${name}^{${object}}`,
      ],
      [0, 1],
    )
  ).trim();
}

async function emptyTree(git: GitRunner, top: string) {
  return (
    (await ask(git, top, ["hash-object", "-t", "tree", "/dev/null"])) ||
    emptyGitTree
  );
}

/** NUL status preserves whitespace, newlines, unicode and rename source paths. */
function statusEntries(status: string) {
  const entries = status.split("\0"),
    files: { status: string; path: string; previous?: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    if (!row) continue;
    const xy = row.slice(0, 2);
    files.push({ status: xy, path: row.slice(3), ...(/[RC]/.test(xy) ? { previous: entries[++i] } : {}) });
  }
  return files;
}

export function statusPaths(status: string) {
  return statusEntries(status).map((file) => file.path);
}

async function status(git: GitRunner, top: string) {
  return git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
}

async function comparison(
  git: GitRunner,
  top: string,
  base: string,
  head?: string,
) {
  const headSha = await resolve(git, top, "HEAD");
  if (!headSha) {
    if (head) return null;
    const tree = await emptyTree(git, top);
    return {
      baseRef: tree,
      from: "",
      merge: tree,
      target: "",
      ahead: 0,
      behind: 0,
      unknown: false,
    };
  }
  const origin =
    base === "HEAD" || base.startsWith("refs/")
      ? ""
      : await resolve(git, top, `refs/remotes/origin/${base}`);
  const resolvedBase = origin || (await resolve(git, top, base));
  if (head && !resolvedBase) return null;
  const from = resolvedBase || headSha;
  const baseRef = origin ? `origin/${base}` : resolvedBase ? base : "HEAD";
  const target = head
    ? (await resolve(git, top, `refs/remotes/origin/${head}`)) ||
      (await resolve(git, top, head))
    : headSha;
  if (!target) return null;
  const merge = await ask(git, top, ["merge-base", from, target]);
  if (
    !merge &&
    (await ask(git, top, ["rev-parse", "--is-shallow-repository"])) !== "false"
  ) {
    if (head) return null;
    return {
      baseRef: headSha,
      from,
      merge: headSha,
      target,
      ahead: 0,
      behind: 0,
      unknown: true,
    };
  }
  const counts = (
    await git(top, [
      "rev-list",
      "--left-right",
      "--count",
      `${from}...${target}`,
    ])
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  return {
    baseRef,
    from,
    merge: merge || from,
    target,
    ahead: counts[1],
    behind: counts[0],
    unknown: false,
  };
}

interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}
const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames"];
const patchArgs = [
  ...diffArgs,
  "--no-color",
  "--inter-hunk-context=1",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

function metadataPatch(filename: string, status: DiffFile["status"]) {
  const header = `diff --git a/${filename} b/${filename}\n`;
  return status === "added" ? `${header}new file mode 100644\n` : header;
}

function foldTrackedFiles(
  tracked: DiffFile[],
  lazy: boolean,
  patches?: ReadonlyMap<string, string>,
) {
  const files: DiffFile[] = [];
  let placeholders = 0,
    folded = 0,
    additions = 0,
    deletions = 0;
  for (const file of tracked) {
    const patch = patches?.get(file.filename);
    if (patch !== undefined) {
      files.push({ ...file, patch });
    } else if (
      lazy
        ? files.length >= MAX_LAZY_TRACKED_FILES
        : placeholders >= MAX_PATCHLESS_TRACKED_FILES
    ) {
      folded++;
      additions += file.additions;
      deletions += file.deletions;
    } else if (lazy) {
      files.push(file);
    } else {
      placeholders++;
      files.push({ ...file, patch: metadataPatch(file.filename, file.status) });
    }
  }
  if (folded) {
    const filename = `… and ${folded} more file${folded === 1 ? "" : "s"}${lazy ? "" : " with diffs too large to display"}`;
    files.push({
      filename,
      status: "modified",
      additions,
      deletions,
      changes: additions + deletions,
      patch: metadataPatch(filename, "modified"),
    });
  }
  return files;
}

function outputExceeded(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

async function filePatch(
  git: GitRunner,
  top: string,
  base: string,
  name: string,
  previous?: string,
) {
  const literal = `:(literal)${name}`;
  try {
    const patch = await git(
      top,
      [
        ...patchArgs,
        base,
        "--",
        literal,
        ...(previous ? [`:(literal)${previous}`] : []),
      ],
      [0],
      MAX_PATCH_BYTES,
    );
    if (patch) return patch.includes("\ndiff --git ") ? "" : patch;
    if (await git(top, ["ls-files", "-z", "--", literal])) return "";
    const untracked = await git(top, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      literal,
    ]);
    if (!untracked) return null;
    return await git(
      top,
      [...patchArgs, "--no-index", "--", "/dev/null", name],
      [0, 1],
      MAX_PATCH_BYTES,
    );
  } catch (error) {
    return outputExceeded(error) ? "" : null;
  }
}

async function diffFiles(
  host: Pick<WorkspaceFs, "git" | "entries">,
  top: string,
  base: string,
  head: string | undefined,
  patches: boolean | { inlineLimit: number },
) {
  const { git } = host;
  const refs = head ? [base, head] : [base];
  const numstat = [...diffArgs, "--numstat", "-z"];
  const [names, stat, untracked] = await Promise.all([
    git(top, [...diffArgs, "--name-status", "-z", ...refs, "--"]),
    git(top, [...numstat, ...refs, "--"]),
    head ? "" : git(top, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const counts = parseDiffNumstat(stat);
  const tracked: DiffFile[] = parseDiffNameStatus(names).map(
    ({ path: filename, status, previousPath }) => {
      const { added = 0, removed = 0 } = counts.get(filename) ?? {};
      return {
        filename,
        status,
        additions: added,
        deletions: removed,
        changes: added + removed,
        ...(previousPath ? { previous_filename: previousPath } : {}),
      };
    },
  );
  const newFiles = untracked
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES);
  const sample = newFiles.slice(0, MAX_UNTRACKED_READ_FILES);
  const entries = sample.length ? await host.entries(top, sample) : undefined;
  const untrackedFiles: DiffFile[] = [];
  for (const [index, filename] of newFiles.entries()) {
    const entry = entries?.get(filename);
    const counted = index < MAX_UNTRACKED_READ_FILES;
    if (counted && !entry) continue;
    const readable = entry && entry.size <= MAX_UNTRACKED_READ_BYTES;
    const stat = readable
      ? await git(
          top,
          [...numstat, "--no-index", "--", "/dev/null", filename],
          [0, 1],
        )
      : "";
    const { added = 0, isBinary = false } =
      parseDiffNumstat(stat).values().next().value ?? {};
    untrackedFiles.push({
      filename,
      status: "added",
      additions: added,
      deletions: 0,
      changes: added,
      ...(!added && !isBinary
        ? { patch: metadataPatch(filename, "added") }
        : {}),
    });
  }
  const trackedPaths = new Set(tracked.map((file) => file.filename));
  const all = tracked.concat(
    untrackedFiles.filter((file) => !trackedPaths.has(file.filename)),
  );
  const totals = {
    additions: all.reduce((sum, file) => sum + file.additions, 0),
    deletions: all.reduce((sum, file) => sum + file.deletions, 0),
    fileCount: all.length,
  };
  const visibleUntracked = (files: DiffFile[]) => {
    const paths = new Set(files.map((file) => file.filename));
    return untrackedFiles.filter((file) => !paths.has(file.filename));
  };
  const withoutPatches = () => {
    const files = foldTrackedFiles(tracked, true);
    return {
      files: files.concat(visibleUntracked(files)),
      patchesWithheld: true,
      totals,
    };
  };
  if (
    patches === false ||
    (typeof patches === "object" &&
      (totals.fileCount > MAX_INLINE_FILES ||
        totals.additions + totals.deletions > patches.inlineLimit))
  )
    return withoutPatches();

  const patchBudget = patches === true ? MAX_PATCH_BYTES : MAX_INLINE_BYTES;
  const readTrackedPatch = (excluded: string[] = []) =>
    git(
      top,
      [
        ...patchArgs,
        ...refs,
        "--",
        ...excluded.map((name) => `:(top,exclude,literal)${name}`),
      ],
      [0],
      patchBudget,
    );
  let raw: string;
  try {
    raw = await readTrackedPatch();
  } catch (error) {
    if (isTransportError(error)) throw error;
    if (patches !== true) return withoutPatches();
    let estimated = Math.max(
      tracked.reduce((sum, file) => sum + file.changes, 0) * 80,
      MAX_PATCH_BYTES + 1,
    );
    const excluded: string[] = [];
    const largest = [...tracked].sort((a, b) => b.changes - a.changes);
    for (const file of largest) {
      if (estimated <= MAX_PATCH_BYTES * 0.8 || file.changes < 2000) break;
      excluded.push(file.filename);
      if (file.previous_filename) excluded.push(file.previous_filename);
      estimated -= file.changes * 80;
    }
    raw = excluded.length
      ? await readTrackedPatch(excluded).catch(() => "")
      : "";
  }
  const trackedPatches = new Map(
    parseGitPatches(raw).map(({ file, patch }) => [file.path, patch]),
  );
  const files = foldTrackedFiles(tracked, patches !== true, trackedPatches);
  let remaining = patchBudget - Buffer.byteLength(raw);
  for (const file of visibleUntracked(files)) {
    const { filename } = file;
    if (file.patch !== undefined) {
      files.push(file);
      continue;
    }
    const limit = patches === true ? MAX_PATCH_BYTES : remaining;
    const patch =
      limit > 0
        ? await git(
            top,
            [...patchArgs, "--no-index", "--", "/dev/null", filename],
            [0, 1],
            limit,
          ).catch(() => null)
        : null;
    if (patch === null && patches !== true) return withoutPatches();
    files.push({ ...file, patch: patch || metadataPatch(filename, "added") });
    remaining -= Buffer.byteLength(patch ?? "");
  }
  return { files, patchesWithheld: false, totals };
}

async function worktreeFile(top: string, name: string, maxBytes: number) {
  const target = path.join(top, name);
  try {
    const realTop = await fs.realpath(top),
      parent = await fs.realpath(path.dirname(target));
    const relative = path.relative(realTop, parent);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw Error("File is outside this repository.");
    const file = path.join(parent, path.basename(target));
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return { target: await fs.readlink(file) };
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return { bytes: await fs.readFile(file) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function textContent(data: Buffer | null) {
  return !data || data.includes(0) ? null : data.toString("utf8");
}

function repositoryRemote(url: string) {
  const match =
    url.match(/^[^@/:#?\s]+@([^:\s]+):([^/\s]+)\/([^/\s]+)$/) ??
    url.match(
      /^(?:https?|ssh|git|git\+ssh|ssh\+git|git\+https?):\/\/(?:[^@/#?\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+)\/?$/,
    );
  if (!match) return undefined;
  let [, hostname, owner, name] = match;
  name = name.replace(/\.git$/, "");
  hostname = hostname.toLowerCase();
  const validPart = (part: string) =>
    /^[a-z0-9._-]+$/i.test(part) && part !== "." && part !== "..";
  if (
    !validPart(owner) ||
    !validPart(name) ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      hostname,
    ) ||
    /^\d+(?:\.\d+){3}$/.test(hostname) ||
    hostname.endsWith(".localhost")
  )
    return undefined;
  if (hostname.endsWith(".github.com")) hostname = "github.com";
  if (hostname.endsWith(".ghe.com"))
    hostname = hostname.split(".").slice(-3).join(".");
  return { hostname, owner, name };
}

async function originDefaultBranch(
  git: GitRunner,
  top: string,
  originUrl: string,
) {
  const prefix = "refs/remotes/origin/";
  const target = await ask(git, top, ["symbolic-ref", "-q", `${prefix}HEAD`]);
  if (target.startsWith(prefix)) return target.slice(prefix.length);
  if (originUrl)
    for (const branch of ["main", "master"])
      if (await resolve(git, top, `${prefix}${branch}`)) return branch;
  return undefined;
}

/** Caller must authorize cwd before entering; never run through the cloud router. */
export async function readOfficialGit(
  input: OfficialGitRequest,
  remote?: Pick<WorkspaceFs, "git" | "entries" | "readFileInside">,
): Promise<unknown> {
  const host = remote ?? localWorkingTree;
  const { git } = host;
  if (input.kind === "changes") {
    try {
      return statusPaths(await status(git, input.cwd));
    } catch (error) {
      if (
        error instanceof Error &&
        (/not a git repository|unable to read current working directory|git unavailable/i.test(
          error.message,
        ) ||
          ("code" in error && error.code === "ENOENT"))
      )
        return [];
      return null;
    }
  }
  let top: string;
  try {
    top = (await git(input.cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  if (input.kind === "workingTreeStatus") {
    try {
      const [porcelain, stats] = await Promise.all([
        status(git, input.cwd),
        git(input.cwd, ["diff", "--no-textconv", "--no-ext-diff", "--numstat", "-z", "HEAD"])
          .catch(() => ""),
      ]);
      const counts = [...parseDiffNumstat(stats).values()];
      return {
        files: statusEntries(porcelain).map(({ status, path, previous }) => ({
          status, path: previous ? `${previous} -> ${path}` : path,
        })),
        additions: counts.reduce((sum, row) => sum + row.added, 0),
        deletions: counts.reduce((sum, row) => sum + row.removed, 0),
      };
    } catch {
      return null;
    }
  }
  if (input.kind === "state") {
    const branch = await ask(git, top, [
      "symbolic-ref",
      "--short",
      "-q",
      "HEAD",
    ]);
    // Conflicts live in the index; avoid scanning every working file on each poll.
    const conflicts = await git(top, ["ls-files", "--unmerged", "-z"]).catch(
      () => null,
    );
    if (conflicts === null) return null;
    const conflicted = Boolean(conflicts);
    const row: OfficialGitRow = {
      cwd: input.cwd,
      ...(branch ? { branch } : {}),
      conflicted,
    };
    const upstream = (
      await git(top, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]).catch(() => "")
    ).trim();
    if (upstream) {
      const [behind, ahead] = (
        await git(top, [
          "rev-list",
          "--left-right",
          "--count",
          `${upstream}...HEAD`,
        ])
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      row.ahead = ahead;
      row.behind = behind;
    }
    return row;
  }
  if (input.kind === "branches")
    return (
      await git(top, [
        "for-each-ref",
        "--format=%(refname:lstrip=2)",
        "refs/heads",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  if (input.kind === "info") {
    const [head, originUrl] = await Promise.all([
      ask(git, top, ["symbolic-ref", "-q", "HEAD"]),
      ask(git, top, ["remote", "get-url", "origin"]),
    ]);
    const origin = repositoryRemote(originUrl);
    const repo =
      origin?.hostname === "github.com" ? `${origin.owner}/${origin.name}` : "";
    const defaultBranch = await originDefaultBranch(git, top, originUrl);
    return {
      repo,
      branch: head.replace(/^refs\/heads\//, "") || "HEAD",
      root: top,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(!remote && origin ? { remote: origin } : {}),
    };
  }
  if (input.kind === "image") {
    const extension = input.file
      .slice(input.file.lastIndexOf(".") + 1)
      .toLowerCase();
    if (
      remote ||
      !/^(png|jpe?g|gif|webp|bmp|avif)$/.test(extension) ||
      !input.file.includes(".")
    )
      return null;
    const bytes = await (
      input.rev
        ? gitImageAtRevision(top, input.file, input.rev)
        : worktreeFile(top, input.file, maxImageBytes).then(
            (file) => file?.bytes,
          )
    ).catch(() => null);
    return bytes?.length && bytes.length <= maxImageBytes
      ? `data:${imageTypes[extension]};base64,${bytes.toString("base64")}`
      : null;
  }
  if (input.kind === "content" || input.kind === "patch") {
    const base = await resolve(git, top, input.base, "tree");
    if (!base) return null;
    if (input.kind === "patch")
      return filePatch(git, top, base, input.file, input.previous);
    const [old, working] = await Promise.all([
      git(
        top,
        [
          "show",
          "--no-textconv",
          "--no-ext-diff",
          `${base}:${input.previous ?? input.file}`,
          "--",
        ],
        [0],
        MAX_TEXT_BYTES,
      ).catch((error) => {
        if (isTransportError(error)) throw error;
        return null;
      }),
      remote
        ? remote
            .readFileInside(
              top,
              path.posix.join(top, input.file),
              MAX_TEXT_BYTES,
            )
            .then(textContent)
            .catch((error) => {
              if (isTransportError(error)) throw error;
              return null;
            })
        : worktreeFile(top, input.file, MAX_TEXT_BYTES).then(
            (file) => file?.target ?? textContent(file?.bytes ?? null),
          ),
    ]);
    const oldText = old?.includes("\0") ? null : old;
    return oldText === null && working === null
      ? null
      : { oldText, newText: working };
  }
  if (input.kind === "commit") {
    const target = await resolve(git, top, input.sha);
    if (!target) return null;
    const parent =
      (
        await git(
          top,
          ["rev-parse", "--verify", "--quiet", `${target}^`],
          [0, 1],
        )
      ).trim() || (await emptyTree(git, top));
    return {
      base_ref: parent,
      head_ref: target,
      merge_base: parent,
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      files: (await diffFiles(host, top, parent, target, true)).files,
    };
  }
  const compare = await comparison(git, top, input.base, input.head);
  if (!compare) return null;
  if (input.kind === "commits") {
    if (compare.unknown) return null;
    if (!compare.ahead) return [];
    const raw = await git(top, [
      "log",
      "-z",
      "--no-show-signature",
      "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ct",
      `${compare.from}..${compare.target}`,
      "--",
    ]);
    const fields = raw.split("\0"),
      rows = [];
    for (let i = 0; i + 5 < fields.length; i += 6)
      rows.push({
        sha: fields[i],
        shortSha: fields[i + 1],
        subject: fields[i + 2],
        authorName: fields[i + 3],
        authorEmail: fields[i + 4],
        date: Number(fields[i + 5]),
      });
    return rows;
  }
  const headRef =
    input.kind === "diff"
      ? (input.head ??
        (await ask(git, top, ["symbolic-ref", "--short", "-q", "HEAD"])))
      : undefined;
  const patches =
    input.kind === "stats"
      ? false
      : input.includePatches !== false
        ? true
        : input.inlinePatchesMaxChangedLines === undefined
          ? false
          : { inlineLimit: input.inlinePatchesMaxChangedLines };
  const { files, patchesWithheld, totals } = await diffFiles(
    host,
    top,
    compare.merge,
    input.head ? compare.target : undefined,
    patches,
  );
  if (input.kind === "stats")
    return {
      ...totals,
      ahead_by: compare.ahead,
      behind_by: compare.behind,
      ...(!input.head && compare.target ? { head_sha: compare.target } : {}),
      ...(compare.unknown ? { base_unknown: true } : {}),
    };
  return {
    base_ref: compare.baseRef,
    head_ref: headRef || "HEAD",
    merge_base: compare.merge,
    ahead_by: compare.ahead,
    behind_by: compare.behind,
    total_commits: compare.ahead,
    ...(compare.unknown ? { base_unknown: true } : {}),
    ...(patches !== true ? { patches_withheld: patchesWithheld } : {}),
    files,
  };
}
