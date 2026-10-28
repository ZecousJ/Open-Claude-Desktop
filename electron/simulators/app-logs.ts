/**
 * Claude's app logs. Capture starts when Claude's 'launch' starts an app, or
 * when 'read' names the bundle id of an app that is already running: `simctl
 * spawn <udid> log stream` for that app's process only. A crash report is the
 * newest .ips file in ~/Library/Logs/DiagnosticReports for the app written
 * since its launch: its header and the crashed thread's backtrace.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  logLevelAtLeast,
  type SimulatorLogEntry,
  type SimulatorLogLevel,
} from "../../shared/simulators";
import { LogCapture, parseIosLogLine } from "./logs";
import type { Runner } from "./runner";

export interface AppLogSession {
  session: string;
  udid: string;
  bundleId: string;
  executable: string;
  launchedAt: number;
  capture: LogCapture;
}

/** The newest entries by default, and the most one read returns. */
export const appLogDefaultTail = 100;
export const appLogMaxTail = 1000;

/** A bundle id as Apple allows it (letters, digits, '.', '-'). */
export const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

/** An entry as one line: time, level, subsystem:category, message. */
export function appLogLine(entry: SimulatorLogEntry) {
  const time = new Date(entry.ts).toISOString().slice(11, 23);
  const scope = [entry.subsystem, entry.category].filter(Boolean).join(":");
  return `${time} ${entry.level.padEnd(7)} ${scope ? `${scope} ` : ""}${entry.message}`;
}

/** The parts of a crash report the tool shows (the header and the crashed thread). */
export function summarizeCrashReport(text: string, limit = 40) {
  const newline = text.indexOf("\n");
  let header: Record<string, unknown> = {};
  let body: Record<string, unknown> = {};
  try {
    header = JSON.parse(newline < 0 ? text : text.slice(0, newline));
    body = newline < 0 ? {} : JSON.parse(text.slice(newline + 1));
  } catch {
    return text
      .split("\n")
      .slice(0, limit + 10)
      .join("\n");
  }
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "")
      lines.push(
        `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      );
  };
  add("App", header.app_name ?? body.procName);
  add(
    "Bundle",
    header.bundleID ??
      (body.bundleInfo as Record<string, unknown> | undefined)
        ?.CFBundleIdentifier,
  );
  add("Version", header.app_version);
  add("Time", header.timestamp ?? body.captureTime);
  const exception = body.exception as Record<string, unknown> | undefined;
  if (exception)
    add(
      "Exception",
      [exception.type, exception.signal, exception.codes]
        .filter(Boolean)
        .join(" "),
    );
  const termination = body.termination as Record<string, unknown> | undefined;
  if (termination)
    add("Termination", termination.indicator ?? termination.reason);
  const asi = body.asi as Record<string, string[]> | undefined;
  if (asi)
    for (const [key, values] of Object.entries(asi))
      add(`Note (${key})`, values.join(" "));
  const threads = Array.isArray(body.threads)
    ? (body.threads as Record<string, unknown>[])
    : [];
  const faulting =
    typeof body.faultingThread === "number"
      ? body.faultingThread
      : threads.findIndex((t) => t.triggered);
  const images = Array.isArray(body.usedImages)
    ? (body.usedImages as Record<string, unknown>[])
    : [];
  const thread = threads[faulting];
  if (thread && Array.isArray(thread.frames)) {
    lines.push(
      `Crashed thread ${faulting}${thread.name ? ` (${thread.name})` : ""}:`,
    );
    (thread.frames as Record<string, unknown>[])
      .slice(0, limit)
      .forEach((frame, index) => {
        const image = images[Number(frame.imageIndex)];
        const name = (image?.name as string | undefined) ?? "???";
        const symbol = frame.symbol
          ? `${frame.symbol} + ${frame.symbolLocation ?? 0}`
          : `+ ${frame.imageOffset ?? 0}`;
        const source = frame.sourceFile
          ? ` (${frame.sourceFile}:${frame.sourceLine ?? "?"})`
          : "";
        lines.push(
          `${String(index).padStart(2)} ${name.padEnd(24)} ${symbol}${source}`,
        );
      });
  }
  return lines.join("\n");
}

export class AppLogs {
  private sessions = new Map<string, AppLogSession>();

  constructor(
    private deps: {
      runner: Runner;
      now?: () => number;
      /** Where crash reports are written (~/Library/Logs/DiagnosticReports). */
      reportsFolder?: () => string;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private key(udid: string, bundleId: string) {
    return `${udid}\n${bundleId}`;
  }

  /** The executable of an installed app (its Info.plist's CFBundleExecutable). */
  async executableOf(udid: string, bundleId: string) {
    const container = (
      await this.deps.runner.run(
        "xcrun",
        ["simctl", "get_app_container", udid, bundleId, "app"],
        {
          timeoutMs: 15_000,
        },
      )
    ).trim();
    const name = (
      await this.deps.runner.run(
        "plutil",
        [
          "-extract",
          "CFBundleExecutable",
          "raw",
          "-o",
          "-",
          path.join(container, "Info.plist"),
        ],
        { timeoutMs: 10_000 },
      )
    ).trim();
    if (!name)
      throw new Error(`Couldn't read the executable name of ${bundleId}.`);
    return name;
  }

  /** Starts (or restarts) capturing an app's log; called when it launches. */
  async start(udid: string, bundleId: string, executable?: string) {
    const key = this.key(udid, bundleId);
    this.sessions.get(key)?.capture.stop();
    const exec = executable ?? (await this.executableOf(udid, bundleId));
    const process = this.deps.runner.start("xcrun", [
      "simctl",
      "spawn",
      udid,
      "log",
      "stream",
      "--style",
      "ndjson",
      "--level",
      "debug",
      "--predicate",
      `process == "${exec.replace(/["\\]/g, "")}"`,
    ]);
    const session: AppLogSession = {
      session: randomBytes(3).toString("hex"),
      udid,
      bundleId,
      executable: exec,
      launchedAt: this.now(),
      capture: new LogCapture(0, process, parseIosLogLine, () => this.now()),
    };
    this.sessions.set(key, session);
    return session;
  }

  /** The newest capture on a device (for 'read' without a bundle id). */
  latest(udid: string) {
    return [...this.sessions.values()]
      .filter((session) => session.udid === udid)
      .sort((a, b) => b.launchedAt - a.launchedAt)[0];
  }

  session(udid: string, bundleId: string) {
    return this.sessions.get(this.key(udid, bundleId));
  }

  /**
   * The captured entries after the cursor, at the level and with the
   * filter asked, the newest `tail`; with the next cursor.
   */
  read(
    session: AppLogSession,
    options: {
      tail?: number;
      since?: string;
      level?: SimulatorLogLevel;
      filter?: string;
    },
  ) {
    let after = 0;
    if (options.since) {
      const [name, seq] = options.since.split(":");
      if (name === session.session && /^\d+$/.test(seq ?? ""))
        after = Number(seq);
    }
    const level = options.level ?? "info";
    const needle = options.filter?.toLowerCase();
    const all = session.capture.read(after, Number.MAX_SAFE_INTEGER);
    const matching = all.filter(
      (entry) =>
        (logLevelAtLeast(entry.level, level) || /crash/i.test(entry.message)) &&
        (!needle ||
          [entry.message, entry.subsystem, entry.category].some((part) =>
            part?.toLowerCase().includes(needle),
          )),
    );
    const tail = Math.min(
      Math.max(1, Math.round(options.tail ?? appLogDefaultTail)),
      appLogMaxTail,
    );
    const shown = matching.slice(-tail);
    const last = all.at(-1)?.seq ?? after;
    return {
      entries: shown,
      dropped: matching.length - shown.length,
      cursor: `${session.session}:${last}`,
      ended: session.capture.ended,
    };
  }

  /** The newest crash report for the app since it launched; undefined when there is none. */
  crashReport(session: AppLogSession) {
    const folder =
      this.deps.reportsFolder?.() ??
      path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
    let names: string[];
    try {
      names = fs.readdirSync(folder).filter((name) => name.endsWith(".ips"));
    } catch {
      return undefined;
    }
    const candidates = names
      .map((name) => {
        const file = path.join(folder, name);
        try {
          return { file, mtime: fs.statSync(file).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter(
        (item): item is { file: string; mtime: number } =>
          !!item && item.mtime >= session.launchedAt - 1000,
      )
      .sort((a, b) => b.mtime - a.mtime);
    for (const { file } of candidates) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const newline = text.indexOf("\n");
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(newline < 0 ? text : text.slice(0, newline));
      } catch {
        continue;
      }
      if (
        header.bundleID === session.bundleId ||
        header.app_name === session.executable
      )
        return { file, summary: summarizeCrashReport(text) };
    }
    return undefined;
  }

  dispose() {
    for (const session of this.sessions.values()) session.capture.stop();
    this.sessions.clear();
  }
}
