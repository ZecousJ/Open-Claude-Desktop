/**
 * The working folder of a cloud Code session (web). A Code conversation on
 * the runner runs in the same sandbox as Chat and Cowork; what differs is
 * its folder: each new session gets its own directory under the sandbox's
 * workspace (`<workspace>/code/<session id>`), so two sessions never share
 * files, and a repository, when one is given, is prepared there.
 *
 * `prepareWorkspace` is the hook the GitHub package fills to clone the
 * repository. Until then it makes an empty folder, and a repository named
 * in `send` is accepted, checked for shape, and not fetched.
 */
import fs from "node:fs";
import path from "node:path";
import type { RepositoryRef } from "../../shared/host";

export type { RepositoryRef };

/** The session a workspace is prepared for. */
export interface WorkspaceSession {
  userId: number;
  /** Names the session's folder; not the conversation id (it does not exist yet). */
  sessionId: string;
  /** The sandbox's workspace folder (`<profile>/workspace`). */
  workspace: string;
}

/**
 * Prepares a new session's folder and returns the one Code runs in. The folder
 * must lie inside `codeWorkspaceRoot(session.workspace)`.
 *
 * `repository` is the session's main repository (its folder is that checkout);
 * `more` are the other repositories the person added to the session, cloned
 * inside it (`extraRepositoryFolders`).
 */
export type PrepareWorkspace = (
  session: WorkspaceSession,
  repository?: RepositoryRef,
  more?: RepositoryRef[],
) => Promise<{ cwd: string }>;

/** The most repositories one session clones. */
export const maxSessionRepositories = 10;

/** Where the sessions' folders live. */
export const codeWorkspaceRoot = (workspace: string) =>
  path.join(workspace, "code");

const idPattern = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether `folder` is a session folder (or inside one) under `workspace`. */
export function inCodeWorkspace(workspace: string, folder: string) {
  const root = codeWorkspaceRoot(workspace);
  const relative = path.relative(root, path.resolve(folder));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/** The default hook: an empty folder for the session; nothing is fetched. */
export const emptyWorkspace: PrepareWorkspace = async (session) => {
  if (!idPattern.test(session.sessionId))
    throw new Error("The session id is not valid.");
  const cwd = path.join(
    codeWorkspaceRoot(session.workspace),
    session.sessionId,
  );
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { cwd };
};

/**
 * The repositories a send names, the main one first: `repositories` (a
 * session with several), else `repository`. Each is checked as
 * `parseRepository` checks one; the same address twice counts once.
 */
export function parseRepositories(input: {
  repository?: unknown;
  repositories?: unknown;
}): RepositoryRef[] {
  const list = input.repositories;
  if (list === undefined || list === null) {
    const one = parseRepository(input.repository);
    return one ? [one] : [];
  }
  if (!Array.isArray(list) || list.length > maxSessionRepositories)
    throw new Error("The repositories are not valid.");
  const out: RepositoryRef[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const repository = parseRepository(value);
    if (!repository) throw new Error("The repository is not valid.");
    const key = repositoryKey(repository.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repository);
  }
  // A `repository` sent beside the list must be the list's first.
  const first = parseRepository(input.repository);
  if (
    first &&
    (!out[0] || repositoryKey(first.url) !== repositoryKey(out[0].url))
  )
    throw new Error("The repositories are not valid.");
  return out;
}

/** An address without case, trailing slash or ".git" (one repository). */
export const repositoryKey = (url: string) =>
  url
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

/** The last two parts of a repository's address, safe as folder names. */
function repositoryName(url: string) {
  const parts = new URL(url).pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const safe = (text: string) =>
    text.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return {
    name: safe(parts.at(-1) ?? "") || "repository",
    owner: safe(parts.at(-2) ?? ""),
  };
}

/**
 * Where the other repositories of a session go: folders inside the main
 * checkout, named after each repository ("owner-name" when two share a
 * name, then a number), never a name the main checkout already has.
 */
export function extraRepositoryFolders(
  cwd: string,
  more: RepositoryRef[],
): string[] {
  const taken = new Set<string>(
    fs.existsSync(cwd)
      ? fs.readdirSync(cwd).map((name) => name.toLowerCase())
      : [],
  );
  taken.add(".git");
  const names = more.map((repository) => repositoryName(repository.url));
  return names.map(({ name, owner }) => {
    const clash = names.filter((other) => other.name === name).length > 1;
    const base = clash && owner ? `${owner}-${name}` : name;
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++)
      candidate = `${base}-${n}`;
    taken.add(candidate.toLowerCase());
    return path.join(cwd, candidate);
  });
}

/**
 * Lists the other repositories' folders in the main checkout's
 * `.git/info/exclude`, so its own status stays its own (nothing to do when
 * the folder is not a checkout).
 */
export function excludeExtraRepositories(cwd: string, folders: string[]) {
  const git = path.join(cwd, ".git");
  if (
    !folders.length ||
    !fs.lstatSync(git, { throwIfNoEntry: false })?.isDirectory()
  )
    return;
  const info = path.join(git, "info");
  fs.mkdirSync(info, { recursive: true });
  const lines = folders.map((folder) => `/${path.basename(folder)}/`);
  fs.appendFileSync(
    path.join(info, "exclude"),
    `\n# Other repositories of this session\n${lines.join("\n")}\n`,
  );
}

/**
 * The repository a send names, or undefined. Only its shape is checked here
 * (an https address without credentials, a plain ref); the hook decides
 * whether it may be cloned.
 */
export function parseRepository(value: unknown): RepositoryRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("The repository is not valid.");
  const { url, ref, branch } = value as {
    url?: unknown;
    ref?: unknown;
    branch?: unknown;
  };
  if (typeof url !== "string" || url.length > 2000)
    throw new Error("The repository address is not valid.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The repository address is not valid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname
  )
    throw new Error("Repositories are cloned over https, without credentials.");
  if (
    ref !== undefined &&
    (typeof ref !== "string" ||
      ref.length > 200 ||
      !/^[A-Za-z0-9._\/@+-]+$/.test(ref) ||
      ref.startsWith("-") ||
      ref.includes(".."))
  )
    throw new Error("The branch is not valid.");
  if (
    branch !== undefined &&
    (typeof branch !== "string" ||
      !ref ||
      branch.length > 200 ||
      !/^[A-Za-z0-9._\/@+-]+$/.test(branch) ||
      branch.startsWith("-") ||
      branch.includes("..") ||
      branch.endsWith(".lock"))
  )
    throw new Error("The branch is not valid.");
  return {
    url: parsed.href,
    ...(ref ? { ref } : {}),
    ...(branch ? { branch } : {}),
  };
}
