/**
 * The pane's Show logs drawer: the device's log read line by line. iOS streams
 * the unified log as JSON (`xcrun simctl spawn <udid> log stream --style ndjson
 * --level debug`); Android reads `adb logcat`
 * in its threadtime format. A capture keeps the latest lines in memory and the
 * window reads what is new since the last line it has.
 *
 * The original reads the log of the app Claude launched (its process id); the
 * pane here shows the whole device, which the drawer's filter narrows.
 */
import path from "node:path";
import type {
  SimulatorLogEntry,
  SimulatorLogLevel,
} from "../../shared/simulators";
import type { RunningProcess } from "./runner";

/** The longest message kept (the original's 4096 characters). */
export const logMessageLimit = 4096;
/** Names (process, subsystem, category) longer than this are cut (the original's 256). */
const nameLimit = 256;
/** Lines one capture keeps; older ones are dropped. */
export const logCapacity = 5000;
/** The most lines one read returns. */
export const logReadLimit = 2000;
/** Lines of history `adb logcat` prints before it follows. */
const logcatBacklog = 200;

const cut = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const name = (value: unknown) =>
  typeof value === "string" && value.length > 0
    ? cut(value, nameLimit)
    : undefined;

/** "2026-10-12 09:41:07.123456+0800" → milliseconds; `fallback` when unreadable. */
export function logTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value))
    return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string") return fallback;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?\s*([+-]\d{2}):?(\d{2})?$/.exec(
      value.trim(),
    );
  if (!match) return fallback;
  const fraction = (match[3] ?? "0").slice(0, 3).padEnd(3, "0");
  const zone = `${match[4]}:${match[5] ?? "00"}`;
  const ms = Date.parse(`${match[1]}T${match[2]}.${fraction}${zone}`);
  return Number.isFinite(ms) ? ms : fallback;
}

const iosLevels: Record<string, SimulatorLogLevel> = {
  debug: "debug",
  info: "info",
  default: "default",
  error: "error",
  fault: "fault",
};

/** One line of `log stream --style ndjson`; null for anything that isn't a log event. */
export function parseIosLogLine(
  line: string,
  now: number,
): Omit<SimulatorLogEntry, "seq"> | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    event = parsed;
  } catch {
    return null;
  }
  if (typeof event.eventType === "string" && event.eventType !== "logEvent")
    return null;
  const message = event.eventMessage ?? event.message;
  if (typeof message !== "string") return null;
  const rawPid = event.processID ?? event.pid;
  const pid =
    typeof rawPid === "number" && Number.isSafeInteger(rawPid) && rawPid >= 0
      ? rawPid
      : typeof rawPid === "string" && /^\d{1,10}$/.test(rawPid)
        ? Number(rawPid)
        : 0;
  const image =
    typeof event.processImagePath === "string"
      ? event.processImagePath
      : undefined;
  const process =
    typeof event.process === "string"
      ? event.process
      : image
        ? path.posix.basename(image)
        : "";
  const type = String(event.messageType ?? event.level ?? "").toLowerCase();
  return {
    ts: logTimestamp(event.timestamp, now),
    level: iosLevels[type] ?? "default",
    process: name(process) ?? "?",
    pid,
    subsystem: name(event.subsystem),
    category: name(event.category),
    message: cut(message, logMessageLimit),
  };
}

const androidLevels: Record<string, SimulatorLogLevel> = {
  V: "debug",
  D: "debug",
  I: "info",
  W: "default",
  E: "error",
  F: "fault",
  A: "fault",
};

const logcatLine =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*: ?(.*)$/;

/**
 * One line of `adb logcat -v threadtime -v year`, read as the emulator's local
 * time.
 */
export function parseLogcatLine(
  line: string,
  now: number,
): Omit<SimulatorLogEntry, "seq"> | null {
  const match = logcatLine.exec(line);
  if (!match) return null;
  const ts = Date.parse(`${match[1]}T${match[2]}.${match[3]}`);
  const pid = Number(match[4]);
  return {
    ts: Number.isFinite(ts) ? ts : now,
    level: androidLevels[match[6]] ?? "default",
    process: String(pid),
    pid,
    subsystem: name(match[7]),
    message: cut(match[8], logMessageLimit),
  };
}

export const logCommands = {
  ios: (udid: string) => [
    "simctl",
    "spawn",
    udid,
    "log",
    "stream",
    "--style",
    "ndjson",
    "--level",
    "debug",
  ],
  android: (serial: string) => [
    "-s",
    serial,
    "logcat",
    "-v",
    "threadtime",
    "-v",
    "year",
    "-T",
    String(logcatBacklog),
  ],
};

/** The latest lines of one running log stream. */
export class LogCapture {
  private entries: SimulatorLogEntry[] = [];
  private nextSeq = 1;
  /** Why the stream stopped, once it has. */
  ended?: string;
  /** When the window last read it. */
  lastRead: number;
  constructor(
    readonly id: number,
    private process: RunningProcess,
    parse: (line: string, now: number) => Omit<SimulatorLogEntry, "seq"> | null,
    private now: () => number,
    private capacity = logCapacity,
  ) {
    this.lastRead = now();
    process.onLine((line) => {
      const entry = parse(line, this.now());
      if (!entry) return;
      this.entries.push({ seq: this.nextSeq++, ...entry });
      if (this.entries.length > this.capacity)
        this.entries.splice(0, this.entries.length - this.capacity);
    });
    void process.exited.then(({ code, signal }) => {
      if (this.ended !== undefined) return;
      const said = process.stderr().trim().split("\n").at(-1)?.trim();
      this.ended =
        said && !/getpwuid_r/.test(said)
          ? cut(said, 300)
          : `The log stream ended${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ""}.`;
    });
  }

  /** The lines after `since` (the newest `limit` of them when there are more). */
  read(since: number, limit = logReadLimit) {
    this.lastRead = this.now();
    const first = this.entries.findIndex((entry) => entry.seq > since);
    const after = first < 0 ? [] : this.entries.slice(first);
    return after.length > limit ? after.slice(-limit) : after;
  }

  stop() {
    this.ended ??= "Stopped.";
    this.process.kill("SIGTERM");
  }
}
