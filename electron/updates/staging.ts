/**
 * The staged update in `<userData>/updates` (package OTA): the verified
 * installer or zip, `staged.json` naming it, and `apply-result.json` that
 * the install helper writes after Claudex quits. No Electron imports.
 */
import fs from "node:fs";
import path from "node:path";
import type { UpdateKind } from "../../shared/app-update";
import { compareVersions } from "../../shared/client-policy-rules";
import { validClaudexVersion } from "../../shared/claudex-contract";

interface StagedFile {
  version: string;
  /** Absolute path of the verified file inside the updates folder. */
  file: string;
  sha256: string;
  stagedAt: number;
  /** Installs started for this version; after two failures it is dropped. */
  attempts: number;
}

export type InstallableUpdate = StagedFile &
  (
    | { kind: Exclude<UpdateKind, "win-app"> }
    | { kind: "win-app"; prepared: string; sourceVersion: string }
  );

export type StagedUpdate =
  InstallableUpdate | (StagedFile & { kind: "win-app"; prepared?: undefined });

/** What the install helper reports. */
export interface ApplyResult {
  ok: boolean;
  version: string;
  error?: string;
  prepared?: string;
  attempts?: number;
}

/** Installs of one version that may fail before the updater stops trying it. */
export const maxInstallAttempts = 2;

export const updatesDir = (userData: string) => path.join(userData, "updates");
const stagedFile = (dir: string) => path.join(dir, "staged.json");
export const applyResultFile = (dir: string) =>
  path.join(dir, "apply-result.json");
const failedFile = (dir: string) => path.join(dir, "failed.json");

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Every platform's kind: a Linux package's record reads back like the others. */
const updateKinds: UpdateKind[] = [
  "mac-zip",
  "win-nsis",
  "win-app",
  "linux-deb",
  "linux-rpm",
  "linux-tar",
];

/** The staged update, when its record is well formed and its file is inside `dir`. */
export function readStaged(dir: string): StagedUpdate | undefined {
  const raw = readJson(stagedFile(dir));
  if (!raw || typeof raw !== "object") return undefined;
  const value: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw),
  );
  const {
    version,
    file,
    sha256,
    stagedAt,
    attempts,
    prepared,
    sourceVersion,
    kind: rawKind,
  } = value;
  const kind = updateKinds.find((known) => known === rawKind);
  if (
    !validClaudexVersion(version) ||
    !kind ||
    typeof file !== "string" ||
    path.dirname(path.resolve(file)) !== path.resolve(dir) ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    return undefined;
  const staged = {
    version,
    file: path.resolve(file),
    sha256,
    stagedAt: typeof stagedAt === "number" ? stagedAt : 0,
    attempts: typeof attempts === "number" ? attempts : 0,
  };
  if (kind !== "win-app") return { ...staged, kind };
  if (
    typeof prepared !== "string" ||
    !path.isAbsolute(prepared) ||
    !validClaudexVersion(sourceVersion)
  )
    return { ...staged, kind };
  const result = readApplyResult(dir);
  return {
    ...staged,
    kind,
    prepared,
    sourceVersion,
    attempts:
      result?.prepared === prepared &&
      result.version === version &&
      result.attempts !== undefined
        ? result.attempts
        : staged.attempts,
  };
}

export function writeStaged(dir: string, staged: StagedUpdate) {
  writeJson(stagedFile(dir), staged);
}

export const stagedRecordFile = stagedFile;

export function readApplyResult(dir: string): ApplyResult | undefined {
  const value = readJson(applyResultFile(dir)) as
    Partial<ApplyResult> | undefined;
  if (
    !value ||
    typeof value.ok !== "boolean" ||
    typeof value.version !== "string"
  )
    return undefined;
  return {
    ok: value.ok,
    version: value.version,
    ...(typeof value.prepared === "string" ? { prepared: value.prepared } : {}),
    ...(typeof value.attempts === "number" ? { attempts: value.attempts } : {}),
    ...(typeof value.error === "string" && value.error
      ? { error: value.error.slice(0, 300) }
      : {}),
  };
}

/** Versions whose install failed `maxInstallAttempts` times. */
export function failedVersions(dir: string): string[] {
  const value = readJson(failedFile(dir));
  return Array.isArray(value)
    ? value.filter((item): item is string => validClaudexVersion(item))
    : [];
}

export function markFailed(dir: string, version: string) {
  writeJson(
    failedFile(dir),
    [...new Set([...failedVersions(dir), version])].slice(-10),
  );
}

export function clearFailed(dir: string) {
  removeQuietly(failedFile(dir));
}

/**
 * Removes a file the update left, or leaves it for the next start when it
 * can't: on Windows a file in use (the installer still running after the
 * person opened it themselves) can't be removed, and that failed Claudex's
 * start ("EPERM ... Claudex-Setup-0.0.33.exe"; owner, 2026-10-22).
 */
function removeQuietly(file: string) {
  try {
    fs.rmSync(file, { recursive: true, force: true });
  } catch {
    // Tried again at the next start.
  }
}

/**
 * Removes every downloaded file except `keep` (a staged or partial file of
 * the version being fetched) and the records.
 */
export function pruneUpdates(dir: string, keep: string[] = []) {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const kept = new Set(keep.map((file) => path.basename(file)));
  for (const name of names) {
    if (
      kept.has(name) ||
      [...kept].some((file) => name.startsWith(`${file}.part`)) ||
      name === "staged.json" ||
      name === "apply-result.json" ||
      name === "failed.json" ||
      name.startsWith("install-update")
    )
      continue;
    removeQuietly(path.join(dir, name));
  }
}

export function clearStaged(dir: string) {
  const staged = readStaged(dir);
  if (staged) removeQuietly(staged.file);
  removeQuietly(stagedFile(dir));
}

export type LaunchDecision =
  /** Keep the staged update for the running updater's idle/work checks. */
  | { action: "defer"; staged: StagedUpdate }
  /** Nothing staged, or the running build already is the staged version. */
  | { action: "none" };

/**
 * What a starting Claudex does with a staged update: one newer than this
 * build that was not installed at the last quit (a crash, or the helper
 * could not run) waits for the idle/work checks; one this build already is, or an older
 * one, is removed; one that failed too often is dropped and remembered.
 */
export function launchDecision(
  dir: string,
  appVersion: string,
): LaunchDecision {
  const staged = readStaged(dir);
  if (!staged) return { action: "none" };
  if (compareVersions(staged.version, appVersion) <= 0) {
    clearStaged(dir);
    return { action: "none" };
  }
  if (
    !fs.existsSync(staged.file) &&
    !(
      staged.kind === "win-app" &&
      staged.prepared &&
      fs.existsSync(staged.prepared)
    )
  ) {
    clearStaged(dir);
    return { action: "none" };
  }
  if (staged.attempts >= maxInstallAttempts) {
    markFailed(dir, staged.version);
    clearStaged(dir);
    return { action: "none" };
  }
  return { action: "defer", staged };
}
