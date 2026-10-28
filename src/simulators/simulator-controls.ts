/**
 * The pure rules behind the device's menus, control bar, frame counter and log
 * drawer. Kept apart from the components so tests can check them without a
 * window.
 */
import {
  logLevelAtLeast,
  logScopeFull,
  type SimulatorKind,
  type SimulatorLogEntry,
  type SimulatorLogLevel,
} from "../../shared/simulators";

// -- Keys on the focused screen ---------------------------------------------

export type ControlShortcut =
  | "back"
  | "rotate"
  | "keyboard"
  | "screenshot"
  | "home"
  | "recents"
  | "appearance"
  | "lock"
  | "volumeUp"
  | "volumeDown";

/**
 * The control bar's and Device menu's shortcuts while the screen has the focus:
 * ⌘S Save screenshot, ⇧⌘H Home, ⇧⌘R Recents (Android), ⇧⌘A Appearance → Toggle
 * and Rotate right (iOS), and Back (⇧⌘B, Android). Matches the focused device
 * controls.
 */
export function controlShortcut(
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  mac: boolean,
  kind: SimulatorKind,
): ControlShortcut | undefined {
  const mod = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return undefined;
  const key = event.key.toLowerCase();
  // The side buttons: ⌘L Lock, and ⌘↑ ⌘↓ the volume where the device has it
  // (Android here).
  if (!event.shiftKey) {
    if (key === "s") return "screenshot";
    if (key === "l") return "lock";
    if (key === "k") return "keyboard";
    if (kind === "ios" && key === "arrowright") return "rotate";
    if (kind === "android" && key === "arrowup") return "volumeUp";
    if (kind === "android" && key === "arrowdown") return "volumeDown";
    return undefined;
  }
  if (key === "h") return "home";
  if (key === "b" && kind === "android") return "back";
  if (key === "r" && kind === "android") return "recents";
  if (key === "a" && kind === "ios") return "appearance";
  return undefined;
}

/** The shortcut each control shows in its tooltip (as `Menu` and `useTooltip` write keys). */
export const controlKeys: Record<ControlShortcut, string[]> = {
  back: ["shift", "mod", "B"],
  rotate: ["mod", "→"],
  keyboard: ["mod", "K"],
  screenshot: ["mod", "S"],
  home: ["shift", "mod", "H"],
  recents: ["shift", "mod", "R"],
  appearance: ["shift", "mod", "A"],
  lock: ["mod", "L"],
  volumeUp: ["mod", "↑"],
  volumeDown: ["mod", "↓"],
};

// -- Frame counter -----------------------------------------------------------

/** Frames are counted over this window (the original's 2 s). */
export const frameWindowMs = 2000;
/** The label is redrawn this often (the original's 1 s). */
export const frameTickMs = 1000;

/**
 * "FPS: {fps}" beside the zoom buttons: how many new pictures of the screen
 * arrived per second over the last two seconds; "idle" once none did but
 * one had before. A picture identical to the one before is not a frame, as
 * a still screen sends no frames in the original's stream.
 */
export class FrameClock {
  private times: number[] = [];
  private last: number | null = null;
  frame(at: number) {
    this.times.push(at);
    this.last = at;
    this.trim(at);
  }
  private trim(now: number) {
    while (this.times.length && now - this.times[0] > frameWindowMs)
      this.times.shift();
  }
  /** null before the first frame. */
  read(now: number): number | "idle" | null {
    this.trim(now);
    if (this.last === null) return null;
    if (!this.times.length) return "idle";
    return this.times.length / (frameWindowMs / 1000);
  }
  reset() {
    this.times = [];
    this.last = null;
  }
}

// -- Log drawer --------------------------------------------------------------

/** The level the drawer starts at (the original's `info`). */
export const defaultLogLevel: SimulatorLogLevel = "info";
/** The levels the Min level menu offers (the original's `vu`: no Crash). */
export const menuLogLevels: readonly SimulatorLogLevel[] = [
  "debug",
  "info",
  "default",
  "error",
  "fault",
];
/** The most lines the drawer keeps (older ones are dropped from the view). */
export const drawerLineLimit = 5000;

/** A level's name; Android's Default is Warning. */
export function logLevelName(level: SimulatorLogLevel, kind: SimulatorKind) {
  if (kind === "android" && level === "default") return "Warning";
  return {
    debug: "Debug",
    info: "Info",
    default: "Default",
    error: "Error",
    fault: "Fault",
    crash: "Crash",
  }[level];
}

/** The level column's short form; Default has none on iOS. */
export function logLevelTag(level: SimulatorLogLevel, kind: SimulatorKind) {
  if (kind === "android" && level === "default") return "warn";
  return level === "default" ? "" : level;
}

/** The text a filter matches: the message, the process and the scope. */
export function logMatches(entry: SimulatorLogEntry, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${entry.message}\n${entry.process}\n${logScopeFull(entry)}`
    .toLowerCase()
    .includes(needle);
}

export function filterLogs(
  entries: readonly SimulatorLogEntry[],
  minLevel: SimulatorLogLevel,
  query: string,
) {
  return entries.filter(
    (entry) =>
      logLevelAtLeast(entry.level, minLevel) && logMatches(entry, query),
  );
}

/** "09:41:07.123" in the computer's time zone. */
export function logTime(ts: number) {
  const date = new Date(ts);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * New lines into the drawer's list: a new capture starts over, lines
 * already held are skipped, and the oldest go once there are too many.
 */
export function mergeLogs(
  held: {
    captureId: number | undefined;
    entries: SimulatorLogEntry[];
    dropped: number;
  },
  captureId: number,
  incoming: readonly SimulatorLogEntry[],
  limit = drawerLineLimit,
) {
  const fresh = held.captureId !== captureId;
  const base = fresh ? [] : held.entries;
  const lastSeq = base.at(-1)?.seq ?? 0;
  const added = incoming.filter((entry) => entry.seq > lastSeq);
  if (!fresh && !added.length) return held;
  const entries = [...base, ...added];
  const over = Math.max(0, entries.length - limit);
  return {
    captureId,
    entries: over ? entries.slice(over) : entries,
    dropped: (fresh ? 0 : held.dropped) + over,
  };
}

/** The scope column's width in characters: the widest label up to 28, at least 4, plus 2. */
export function scopeColumnChars(labels: readonly string[]) {
  let widest = 0;
  for (const label of labels) {
    if (label.length > widest) widest = label.length;
    if (widest >= 28) break;
  }
  return Math.max(4, Math.min(28, widest)) + 2;
}

/** Scope column bounds. */
export function clampScopeWidth(width: number) {
  return Number.isFinite(width)
    ? Math.min(640, Math.max(48, Math.round(width)))
    : 48;
}
