/**
 * The repositories the web Code home's next session starts with. The repository
 * picker (GitHub package) chooses them; the composer's send reads
 * `currentCodeRepositories()` for a new Code session and the runner clones them,
 * the first into the session's folder and the others inside it
 * (runner/src/code-workspace.ts).
 *
 * A session takes several repositories, a pill each with its branch, plus an
 * Add trigger. The choice outlives the home: the chips read it back from here,
 * so what they show is what the next send takes, and the browser keeps it for
 * the next visit.
 */
import { useSyncExternalStore } from "react";
import type { RepositoryRef } from "../../shared/host";
import { onForgetAccountData } from "../app/forget-account-data";

/** A repository the chips show, and its branch. */
export interface ChosenRepository {
  /** "owner/name" */
  fullName: string;
  url: string;
  defaultBranch: string;
  branch: string;
}

/** The most repositories one session takes (the runner's own limit). */
export const maxCodeRepositories = 10;

const storageKey = "claudex.code.repositories";
/** Where one chosen repository was kept before sessions took several. */
const legacyStorageKey = "claudex.code.repository";

let chosen: ChosenRepository[] = [];
/** A repository set without a chip (`setCodeRepository`). */
let direct: RepositoryRef | undefined;
let restored = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Sets what the next session sends; the chips show only chosen
 * repositories. Clearing it (the desktop leaving its cloud environment)
 * keeps the stored choice for the next time the chips show.
 */
export function setCodeRepository(next: RepositoryRef | undefined) {
  direct = next;
  if (!next) restored = false;
  if (!next || chosen[0]?.url !== next.url) chosen = [];
  if (next) pickerPending = false;
  changed();
}

/** The main repository of a new cloud Code session, if one was chosen. */
export const currentCodeRepository = (): RepositoryRef | undefined =>
  direct ?? (chosen[0] && refOf(chosen[0]));

/** Every repository of a new cloud Code session, the main one first. */
export const currentCodeRepositories = (): RepositoryRef[] =>
  direct ? [direct, ...chosen.slice(1).map(refOf)] : chosen.map(refOf);

/** The main repository the chips show, if one was chosen. */
export const chosenCodeRepository = () => chosen[0];

/** Every repository the chips show. */
export const chosenCodeRepositories = () => chosen;

const refOf = (repository: ChosenRepository) =>
  repositoryRef(repository.url, repository.defaultBranch, repository.branch);

function save(next: ChosenRepository[]) {
  try {
    if (next.length) localStorage.setItem(storageKey, JSON.stringify(next));
    else localStorage.removeItem(storageKey);
    localStorage.removeItem(legacyStorageKey);
  } catch {
    // No storage (a private window, a test): kept for this visit only.
  }
}

function commit(next: ChosenRepository[]) {
  restored = true;
  direct = undefined;
  chosen = next.slice(0, maxCodeRepositories);
  save(chosen);
  if (chosen.length) pickerPending = false;
  changed();
}

/** The picker's only choice, or none ("No repository", a disconnect). */
export function chooseCodeRepository(next: ChosenRepository | undefined) {
  commit(next ? [next] : []);
}

/** Add repository: one more pill (a repository already there stays one). */
export function addCodeRepository(next: ChosenRepository) {
  if (chosen.some((r) => sameRepository(r.fullName, next.fullName))) return;
  commit([...chosen, next]);
}

/** A pill's × (Remove {repoName}): the session keeps the others. */
export function removeCodeRepository(fullName: string) {
  commit(chosen.filter((r) => !sameRepository(r.fullName, fullName)));
}

/**
 * A pill's repository menu: another repository in its place, on its
 * default branch; one already chosen elsewhere moves here instead.
 */
export function swapCodeRepository(fullName: string, next: ChosenRepository) {
  if (sameRepository(fullName, next.fullName)) return;
  commit(
    chosen
      .filter((r) => !sameRepository(r.fullName, next.fullName))
      .map((r) => (sameRepository(r.fullName, fullName) ? next : r)),
  );
}

/** A pill's branch menu. */
export function setCodeRepositoryBranch(fullName: string, branch: string) {
  commit(
    chosen.map((r) =>
      sameRepository(r.fullName, fullName) ? { ...r, branch } : r,
    ),
  );
}

/** A stored choice, read back only when it has every field. */
export function parseChosenRepository(
  value: unknown,
): ChosenRepository | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? x : "");
  const [fullName, url, defaultBranch, branch] = [
    text(v.fullName),
    text(v.url),
    text(v.defaultBranch),
    text(v.branch),
  ];
  if (!fullName.includes("/") || !url.startsWith("https://") || !branch)
    return undefined;
  return { fullName, url, defaultBranch, branch };
}

/** A stored list (or the one repository an older visit kept). */
export function parseChosenRepositories(value: unknown): ChosenRepository[] {
  const list = Array.isArray(value) ? value : [value];
  const out: ChosenRepository[] = [];
  for (const item of list) {
    const repository = parseChosenRepository(item);
    if (
      repository &&
      !out.some((r) => sameRepository(r.fullName, repository.fullName))
    )
      out.push(repository);
  }
  return out.slice(0, maxCodeRepositories);
}

/**
 * The choice of an earlier visit, once, when the chips first show and
 * nothing is chosen yet. The desktop's cloud environment calls it too.
 */
export function restoreCodeRepository() {
  if (restored) return;
  restored = true;
  if (chosen.length || direct) return;
  let stored: ChosenRepository[] = [];
  try {
    const raw =
      localStorage.getItem(storageKey) ??
      localStorage.getItem(legacyStorageKey);
    stored = raw ? parseChosenRepositories(JSON.parse(raw)) : [];
  } catch {
    stored = [];
  }
  if (!stored.length) return;
  chosen = stored;
  changed();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The chips' view of the main repository. */
export function useChosenRepository() {
  return useSyncExternalStore(
    subscribe,
    () => chosen[0],
    () => chosen[0],
  );
}

/** The chips' view of every chosen repository. */
export function useChosenRepositories() {
  return useSyncExternalStore(
    subscribe,
    () => chosen,
    () => chosen,
  );
}

/**
 * What a chosen repository and branch send: the default branch is what a
 * missing `ref` means, so it is left out.
 */
export function repositoryRef(
  url: string,
  defaultBranch: string,
  branch: string,
): RepositoryRef {
  return {
    url,
    ...(branch && branch !== defaultBranch ? { ref: branch } : {}),
  };
}

/**
 * Sending from the cloud Code home without a repository opens the repository
 * picker instead. The workspace bar listens; a request made while no bar is
 * mounted waits for the next one.
 */
const pickerListeners = new Set<() => void>();
let pickerPending = false;

// Signing out forgets the chips too (their stored choice goes with it).
onForgetAccountData(() => {
  chosen = [];
  direct = undefined;
  restored = false;
  pickerPending = false;
  changed();
});

export function requestRepositoryPicker() {
  if (pickerListeners.size === 0) {
    pickerPending = true;
    return;
  }
  for (const listener of pickerListeners) listener();
}

/** The workspace bar's subscription: called now for a waiting request. */
export function onRepositoryPickerRequest(listener: () => void) {
  pickerListeners.add(listener);
  if (pickerPending && !currentCodeRepository()) {
    pickerPending = false;
    listener();
  }
  return () => {
    pickerListeners.delete(listener);
  };
}
