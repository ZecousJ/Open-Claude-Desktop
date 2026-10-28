/**
 * Claude's headless iOS builds. A build is `xcrun xcodebuild … build` into a
 * derived data folder of its own under the system's temporary folder; its
 * output goes to a log file, its compile errors are kept as they arrive, and
 * once it succeeds the built .app is found under Build/Products. One build per
 * project at a time.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Runner, RunningProcess } from "./runner";

export type BuildContainerKind = "project" | "workspace";

export interface BuildRequest {
  containerPath: string;
  containerKind: BuildContainerKind;
  scheme: string;
  configuration: string;
  /** An xcodebuild -destination ("platform=iOS Simulator,id=…"). */
  destination: string;
}

export interface BuildRecord extends BuildRequest {
  id: string;
  logPath: string;
  derivedDataPath: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "succeeded" | "failed";
  /** The compile errors so far ("file:line:col: error: …"), the first ones kept. */
  errors: string[];
  errorCount: number;
  warningCount: number;
  /** The built .app, once the build succeeded. */
  appPath?: string;
  exitCode?: number | null;
  /** The last lines of output, for a failure without compile errors. */
  tail: string[];
}

/** Errors kept per build; the count goes on. */
const keptErrors = 20;
const tailLines = 15;

/** Why a scheme or configuration can't be passed to xcodebuild; undefined when fine. */
export function buildNameProblem(
  value: string,
  what: "scheme" | "configuration",
) {
  if (!value.trim()) return `'${what}' can't be empty.`;
  if (value.startsWith("-")) return `'${what}' can't start with '-'.`;
  if (value.length > 200) return `'${what}' is too long.`;
  if (/[\u0000-\u001f\u007f]/.test(value))
    return `'${what}' can't contain control characters.`;
  return undefined;
}

/**
 * The container as xcodebuild takes it: an absolute path that exists and
 * ends in .xcodeproj (project) or .xcworkspace (workspace); throws with
 * the reason otherwise.
 */
export function resolveContainer(raw: string, kind: BuildContainerKind) {
  const extension = kind === "project" ? ".xcodeproj" : ".xcworkspace";
  const name = kind === "project" ? "project_path" : "workspace_path";
  if (!path.isAbsolute(raw))
    throw new Error(
      `'${name}' must be an absolute path (relative paths are rejected).`,
    );
  let resolved = path.resolve(raw).replace(/\/+$/, "");
  if (!resolved.endsWith(extension))
    throw new Error(`'${name}' must point at a ${extension}.`);
  try {
    resolved = fs.realpathSync(resolved);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new Error(
      `${raw.slice(0, 300)} doesn't exist or isn't a ${extension}.`,
    );
  }
  return resolved;
}

/** A compile error or warning line of xcodebuild's output. */
export function classifyBuildLine(
  line: string,
): "error" | "warning" | undefined {
  if (
    /^\S.*?:\d+(:\d+)?: (fatal )?error: /.test(line) ||
    /^(xcodebuild: )?error: /.test(line)
  )
    return "error";
  if (/^\S.*?:\d+(:\d+)?: warning: /.test(line)) return "warning";
  return undefined;
}

export class SimulatorBuilds {
  private builds = new Map<string, BuildRecord>();
  private processes = new Map<string, RunningProcess>();

  constructor(
    private deps: {
      runner: Runner;
      /** Where derived data and logs go (the system's temporary folder). */
      root: () => string;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** The build still running for this container, if any. */
  running(containerPath: string) {
    return [...this.builds.values()].find(
      (build) =>
        build.containerPath === containerPath && build.state === "running",
    );
  }

  async start(request: BuildRequest): Promise<BuildRecord> {
    const busy = this.running(request.containerPath);
    if (busy)
      throw new Error(
        `a build for this project is already running (${busy.id}, started ${Math.round((this.now() - busy.startedAt) / 1000)}s ago, ${busy.errorCount} errors so far). Poll it with build_status or wait for it to finish.`,
      );
    const id = `b-${randomBytes(4).toString("hex")}`;
    const key = createHash("sha256")
      .update(`${request.containerPath}\n${request.scheme}`)
      .digest("hex")
      .slice(0, 16);
    const root = path.join(this.deps.root(), "claudex-ios-builds");
    const derivedDataPath = path.join(root, key);
    fs.mkdirSync(derivedDataPath, { recursive: true });
    const logPath = path.join(root, `${id}.log`);
    const log = fs.createWriteStream(logPath, { mode: 0o600 });
    const record: BuildRecord = {
      ...request,
      id,
      logPath,
      derivedDataPath,
      startedAt: this.now(),
      state: "running",
      errors: [],
      errorCount: 0,
      warningCount: 0,
      tail: [],
    };
    this.builds.set(id, record);
    const child = this.deps.runner.start("xcrun", [
      "xcodebuild",
      request.containerKind === "project" ? "-project" : "-workspace",
      request.containerPath,
      "-scheme",
      request.scheme,
      "-configuration",
      request.configuration,
      "-destination",
      request.destination,
      "-derivedDataPath",
      derivedDataPath,
      "-skipMacroValidation",
      "build",
    ]);
    this.processes.set(id, child);
    child.onLine((line) => {
      log.write(`${line}\n`);
      record.tail.push(line);
      if (record.tail.length > tailLines) record.tail.shift();
      const kind = classifyBuildLine(line);
      if (kind === "warning") record.warningCount++;
      if (kind === "error") {
        record.errorCount++;
        if (record.errors.length < keptErrors && !record.errors.includes(line))
          record.errors.push(line.slice(0, 1000));
      }
    });
    void child.exited.then(({ code }) => {
      const stderr = child.stderr();
      if (stderr) log.write(stderr);
      log.end();
      this.processes.delete(id);
      record.exitCode = code;
      record.endedAt = this.now();
      if (code === 0) {
        record.appPath = this.findApp(record);
        record.state = "succeeded";
      } else {
        record.state = "failed";
        if (!record.errorCount && stderr)
          record.tail.push(...stderr.trim().split("\n").slice(-5));
      }
    });
    return record;
  }

  /** The built .app under Build/Products/<Configuration>-iphonesimulator. */
  private findApp(record: BuildRecord) {
    const products = path.join(
      record.derivedDataPath,
      "Build",
      "Products",
      `${record.configuration}-iphonesimulator`,
    );
    try {
      const apps = fs
        .readdirSync(products)
        .filter((name) => name.endsWith(".app"))
        .map((name) => path.join(products, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return apps[0];
    } catch {
      return undefined;
    }
  }

  status(id: string) {
    return this.builds.get(id);
  }

  /** Stops every running build (sign-out, quit). */
  dispose() {
    for (const child of this.processes.values()) child.kill();
    this.processes.clear();
  }
}

/** A build's status as the tool reports it (the original's `en`). */
export function buildStatusText(build: BuildRecord, now: number) {
  const seconds = Math.round(((build.endedAt ?? now) - build.startedAt) / 1000);
  const head =
    build.state === "running"
      ? `Build ${build.id} is running (${seconds}s so far, ${build.errorCount} errors, ${build.warningCount} warnings). Poll build_status again in a little while.`
      : build.state === "succeeded"
        ? `Build ${build.id} succeeded in ${seconds}s (${build.warningCount} warnings).${build.appPath ? ` Built app: ${build.appPath}\nInstall and run it with the 'control' tool: {"action": "launch", "app_path": "${build.appPath}"}` : " The built .app wasn't found under the derived data folder; check the log."}`
        : `Build ${build.id} failed after ${seconds}s with ${build.errorCount} errors (exit code ${build.exitCode ?? "none"}).`;
  const errors = build.errors.length
    ? `\nErrors${build.errorCount > build.errors.length ? ` (first ${build.errors.length} of ${build.errorCount})` : ""}:\n${build.errors.join("\n")}`
    : build.state === "failed" && build.tail.length
      ? `\nLast output:\n${build.tail.join("\n")}`
      : "";
  return `${head}${errors}\nFull log: ${build.logPath}`;
}
