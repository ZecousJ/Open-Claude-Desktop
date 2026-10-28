import {
  avdNamePattern,
  emulatorSerialPattern,
  type AndroidButton,
  type KeyName,
} from "../../shared/simulators";
import { type RawElement } from "./driver";
import type { Runner } from "./runner";

// -- Key codes and text ------------------------------------------------------

const xmlEntities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

const unescapeXml = (value: string) =>
  value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (entity) => xmlEntities[entity] ?? entity,
    );

/**
 * `uiautomator dump`'s view hierarchy: each <node> with its class, text,
 * content description, resource id, enabled and bounds "[x1,y1][x2,y2]" in
 * screen pixels; depth from the nesting.
 */
export function parseUiDump(xml: string): RawElement[] {
  const out: RawElement[] = [];
  let depth = -1;
  for (const match of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    if (match[1]) {
      depth--;
      continue;
    }
    depth++;
    const attrs: Record<string, string> = {};
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g))
      attrs[attr[1]] = unescapeXml(attr[2]);
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(
      attrs.bounds ?? "",
    );
    if (bounds) {
      const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
      if (x2 > x1 && y2 > y1) {
        const text = (value?: string) =>
          value && value.trim() ? value.trim().slice(0, 500) : undefined;
        out.push({
          type: text(attrs.class) ?? "View",
          label: text(attrs["content-desc"]) ?? text(attrs.text),
          value:
            attrs["content-desc"] && attrs.text ? text(attrs.text) : undefined,
          identifier: text(attrs["resource-id"]),
          frame: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
          depth,
          enabled:
            attrs.enabled === undefined ? undefined : attrs.enabled === "true",
        });
      }
    }
    if (match[3]) depth--;
  }
  return out;
}

/** Android key codes for the hardware buttons (`input keyevent`). */
export const androidKeyCodes: Record<AndroidButton, number> = {
  HOME: 3,
  BACK: 4,
  RECENTS: 187,
  LOCK: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
};

/** The keys typed on the pane that are not characters. */
export const androidKeyEvents: Record<KeyName, number> = {
  ENTER: 66,
  BACKSPACE: 67,
};

/** Most characters one `input text` carries. */
const textChunk = 200;

/**
 * Text `input text` can type without a shell reading it: letters, digits,
 * and a few punctuation marks; a space is `%s`. Everything else is dropped
 * and counted (the original does the same for non-ASCII and shell
 * metacharacters).
 */
export function androidTextInput(value: string): {
  chunks: string[];
  typed: number;
  dropped: number;
} {
  let kept = "";
  let dropped = 0;
  for (const character of value) {
    if (/^[A-Za-z0-9._,:@+=/-]$/.test(character)) kept += character;
    else if (character === " ") kept += "%s";
    else dropped++;
  }
  const chunks: string[] = [];
  for (let at = 0; at < kept.length;) {
    // Never split a "%s".
    let end = Math.min(at + textChunk, kept.length);
    if (end < kept.length && kept[end - 1] === "%") end--;
    chunks.push(kept.slice(at, end));
    at = end;
  }
  return { chunks, typed: value.length - dropped, dropped };
}

/** One argument for the device's shell: in single quotes. */
export function deviceQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// -- Command builders --------------------------------------------------------

const as = (serial: string) => ["-s", serial];

export const adbCommands = {
  devices: () => ["devices", "-l"],
  avdName: (serial: string) => [...as(serial), "emu", "avd", "name"],
  bootCompleted: (serial: string) => [
    ...as(serial),
    "shell",
    "getprop",
    "sys.boot_completed",
  ],
  kill: (serial: string) => [...as(serial), "emu", "kill"],
  /** "Physical density: 420", then "Override density: …" when one is set. */
  density: (serial: string) => [...as(serial), "shell", "wm", "density"],
  screenshot: (serial: string) => [
    ...as(serial),
    "exec-out",
    "screencap",
    "-p",
  ],
  tap: (serial: string, x: number, y: number) => [
    ...as(serial),
    "shell",
    "input",
    "tap",
    String(Math.round(x)),
    String(Math.round(y)),
  ],
  /** A swipe from a point to itself is a long press. */
  swipe: (
    serial: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ) => [
    ...as(serial),
    "shell",
    "input",
    "swipe",
    String(Math.round(from.x)),
    String(Math.round(from.y)),
    String(Math.round(to.x)),
    String(Math.round(to.y)),
    String(Math.round(durationMs)),
  ],
  motion: (
    serial: string,
    phase: "DOWN" | "MOVE" | "UP",
    x: number,
    y: number,
  ) => [
    ...as(serial),
    "shell",
    "input",
    "motionevent",
    phase,
    String(Math.round(x)),
    String(Math.round(y)),
  ],
  // One argument, so adb hands the device's shell a single quoted word.
  text: (serial: string, chunk: string) => [
    ...as(serial),
    "shell",
    `input text ${deviceQuote(chunk)}`,
  ],
  key: (serial: string, code: number) => [
    ...as(serial),
    "shell",
    "input",
    "keyevent",
    String(code),
  ],
  openUrl: (serial: string, url: string) => [
    ...as(serial),
    "shell",
    `am start -a android.intent.action.VIEW -d ${deviceQuote(url)}`,
  ],
  install: (serial: string, apk: string) => [
    ...as(serial),
    "install",
    "-r",
    apk,
  ],
  /**
   * Whether the on-screen keyboard shows while a hardware keyboard is
   * attached (the emulator's is): "1", "0" or "null" (never set, off).
   */
  softKeyboard: (serial: string, show?: boolean) => [
    ...as(serial),
    "shell",
    "settings",
    show === undefined ? "get" : "put",
    "secure",
    "show_ime_with_hard_keyboard",
    ...(show === undefined ? [] : [show ? "1" : "0"]),
  ],
  /** The view hierarchy as XML on standard output. */
  uiDump: (serial: string) => [
    ...as(serial),
    "exec-out",
    "uiautomator",
    "dump",
    "/dev/tty",
  ],
  /** A foldable's hinge sensor through the emulator console: read, or set in degrees. */
  hinge: (serial: string, degrees?: number) => [
    ...as(serial),
    "emu",
    "sensor",
    degrees === undefined ? "get" : "set",
    "hinge-angle0",
    ...(degrees === undefined ? [] : [degrees.toFixed(1)]),
  ],
  /** Airplane mode (Android 10 and later): read, or switch first. */
  airplaneMode: (serial: string, on?: boolean) => [
    ...as(serial),
    "shell",
    "cmd",
    "connectivity",
    "airplane-mode",
    ...(on === undefined ? [] : [on ? "enable" : "disable"]),
  ],
  /** One of the three animation scales: read, or set to `scale`. */
  animationScale: (serial: string, setting: string, scale?: number) => [
    ...as(serial),
    "shell",
    "settings",
    scale === undefined ? "get" : "put",
    "global",
    setting,
    ...(scale === undefined ? [] : [String(scale)]),
  ],
  // `monkey` starts a package's launcher activity without knowing its name.
  start: (serial: string, packageId: string) => [
    ...as(serial),
    "shell",
    "monkey",
    "-p",
    packageId,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ],
};

/** `emulator -avd <name> -no-window` (the pane shows the screen). */
export const emulatorCommands = {
  listAvds: () => ["-list-avds"],
  start: (avd: string) => ["-avd", avd, "-no-window"],
};

// -- Parsers -----------------------------------------------------------------

export interface RunningEmulator {
  serial: string;
  /** "device" (up), "offline" (still booting), … */
  state: string;
}

/** The emulators `adb devices -l` lists; a phone or tablet on a cable is ignored. */
export function parseAdbDevices(text: string): RunningEmulator[] {
  const found: RunningEmulator[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (!match || !emulatorSerialPattern.test(match[1])) continue;
    found.push({ serial: match[1], state: match[2] });
  }
  return found;
}

/** The virtual device names `emulator -list-avds` prints (it also prints INFO lines). */
export function parseAvdList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => avdNamePattern.test(line) && !/^INFO\b/.test(line));
}

/** The AVD a running emulator reports to `adb emu avd name` ("Pixel_9_API_35\nOK"). */
export function parseAvdName(text: string): string | undefined {
  const first = text.split("\n")[0]?.trim();
  return first && avdNamePattern.test(first) ? first : undefined;
}

/** The name Android Studio shows for a virtual device, from its config.ini. */
export function parseAvdDisplayName(config: string): string | undefined {
  const match = /^avd\.ini\.displayname\s*=\s*(.+)$/m.exec(config);
  const name = match?.[1].trim();
  return name ? name.slice(0, 120) : undefined;
}

/** The baseline density one density-independent pixel is measured at. */
export const androidBaselineDpi = 160;

/**
 * The density `wm density` reports: the override when one is set (that is
 * what apps lay out with), else the physical one.
 */
export function parseDensity(text: string): number | undefined {
  const read = (label: string) => {
    const match = new RegExp(`${label} density:\\s*(\\d+)`, "i").exec(text);
    const dpi = match ? Number(match[1]) : NaN;
    return dpi > 0 && dpi < 2000 ? dpi : undefined;
  };
  return read("Override") ?? read("Physical");
}

// -- Driver ------------------------------------------------------------------

export interface AndroidDeps {
  runner: Runner;
  adb(): Promise<string | undefined>;
  emulator(): Promise<string | undefined>;
  /** The virtual device's config.ini text, or undefined. */
  avdConfig(name: string): Promise<string | undefined>;
  /** Whether a file exists (the APK). */
  isFile(path: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** A cold boot can take minutes on a slow machine. */
export const bootTimeoutMs = 300_000;

export const bootPollMs = 1500;
