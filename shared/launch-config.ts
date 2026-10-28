/**
 * `.claude/launch.json`: the dev servers of a folder, in the format Claude's
 * desktop app and Claude Code use (R8-B):
 *
 *     { "version": "0.0.1",
 *       "configurations": [{ "name": "web", "runtimeExecutable": "npm",
 *                            "runtimeArgs": ["run", "dev"], "port": 5173 }] }
 *
 * A configuration may also give `url` (a local address to open instead of
 * http://localhost:<port>), `cwd` (a folder inside the project) and `env`.
 * A configuration with `url` and no `runtimeExecutable` attaches to a server
 * that is already running and starts nothing.
 *
 * Pure functions only (no file access), so the panel and the main process
 * share them: parsing and checking the file, adding a configuration, and
 * splitting and showing a command line. The command never runs through a
 * shell.
 */
import type { LaunchConfiguration } from "./browser";

export const launchConfigVersion = "0.0.1";
/** Where configurations are written, relative to the session's folder. */
export const launchConfigPath = ".claude/launch.json";
/** Read when `.claude/launch.json` does not exist; never written. */
export const launchConfigFallbackPath = ".claudex/launch.json";

export const launchLimits = {
  configurations: 50,
  name: 64,
  executable: 256,
  args: 64,
  arg: 4096,
  env: 32,
  envName: 256,
  envValue: 8192,
  cwd: 1024,
  url: 2048,
  fileBytes: 256 * 1024,
} as const;

/**
 * One configuration as read from the file. `runtimeExecutable` is missing
 * for a configuration that only opens `url` (a server started elsewhere).
 */
export interface LaunchEntry extends Omit<
  LaunchConfiguration,
  "runtimeExecutable"
> {
  runtimeExecutable?: string;
}

export interface LaunchFile {
  version: string;
  configurations: LaunchEntry[];
}

export interface LaunchParseResult {
  /** The configurations that are valid, in file order. */
  configurations: LaunchEntry[];
  /** The first problem, for the panel ("launch.json: …"); missing when the file is fine. */
  error?: string;
  /** Everything else the file holds, kept when a configuration is added. */
  extra: Record<string, unknown>;
  /** Entries that failed their checks, kept as written when the file is saved again. */
  invalid: unknown[];
  /**
   * Every configuration as written, in file order: saving replaces or adds
   * one and keeps the others untouched (fields this app doesn't know too).
   */
  raw?: unknown[];
}

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** localhost, 127.0.0.1, [::1] and *.localhost: this computer. */
export function isLocalHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    localHostnames.has(host) ||
    host.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** The port an http(s) URL connects to. */
export function urlPort(url: URL) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * The address a configuration opens: its `url`, or http://localhost:<port>;
 * undefined when it gives neither.
 */
export function launchUrl(entry: Pick<LaunchEntry, "url" | "port">) {
  if (entry.url) return entry.url;
  if (entry.port) return `http://localhost:${entry.port}`;
  return undefined;
}

/** The port to wait for: `port`, or the one in `url`. */
export function launchPort(entry: Pick<LaunchEntry, "url" | "port">) {
  if (entry.port) return entry.port;
  if (!entry.url) return undefined;
  try {
    return urlPort(new URL(entry.url));
  } catch {
    return undefined;
  }
}

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why one configuration is not usable, or undefined when it is. */
export function launchEntryProblem(
  raw: unknown,
  index = 0,
): string | undefined {
  const label = `configuration ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return `${label} isn't an object.`;
  const entry = raw as Record<string, unknown>;
  const name = entry.name;
  if (typeof name !== "string" || !name.trim())
    return `${label} needs a "name".`;
  if (name.length > launchLimits.name || /[\u0000-\u001f]/.test(name))
    return `${label}: the name is too long or has control characters.`;
  const named = `"${name}"`;
  const exe = entry.runtimeExecutable;
  if (exe !== undefined) {
    if (typeof exe !== "string" || !exe.trim())
      return `${named}: "runtimeExecutable" must be a command, like "npm".`;
    if (exe.length > launchLimits.executable || /[\u0000\n\r]/.test(exe))
      return `${named}: "runtimeExecutable" is too long or has line breaks.`;
  }
  const args = entry.runtimeArgs;
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
      return `${named}: "runtimeArgs" must be a list of strings.`;
    if (args.length > launchLimits.args)
      return `${named}: "runtimeArgs" can have at most ${launchLimits.args} items.`;
    if (
      args.some(
        (arg: string) => arg.length > launchLimits.arg || arg.includes("\0"),
      )
    )
      return `${named}: an argument is too long.`;
    if (exe === undefined)
      return `${named}: "runtimeArgs" needs a "runtimeExecutable".`;
  }
  const port = entry.port;
  if (port !== undefined) {
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      return `${named}: "port" must be a number from 1 to 65535.`;
  }
  const url = entry.url;
  if (url !== undefined) {
    if (typeof url !== "string" || url.length > launchLimits.url)
      return `${named}: "url" must be an address.`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `${named}: "url" isn't a valid address.`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return `${named}: "url" must start with http:// or https://.`;
    if (!isLocalHostname(parsed.hostname))
      return `${named}: "url" must be on this computer (localhost).`;
    if (parsed.username || parsed.password)
      return `${named}: "url" can't include a user name or password.`;
    if (typeof port === "number" && urlPort(parsed) !== port)
      return `${named}: the port in "url" doesn't match "port".`;
  }
  if (exe === undefined && url === undefined)
    return `${named} needs a "runtimeExecutable" (or a "url" of a server that is already running).`;
  const cwd = entry.cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== "string" || cwd.length > launchLimits.cwd)
      return `${named}: "cwd" must be a folder path.`;
    if (!relativeInside(cwd))
      return `${named}: "cwd" must be a folder inside this project.`;
  }
  const env = entry.env;
  if (env !== undefined) {
    if (!env || typeof env !== "object" || Array.isArray(env))
      return `${named}: "env" must be an object of names and values.`;
    const pairs = Object.entries(env as Record<string, unknown>);
    if (pairs.length > launchLimits.env)
      return `${named}: "env" can have at most ${launchLimits.env} variables.`;
    for (const [key, value] of pairs) {
      if (key.length > launchLimits.envName || !envNamePattern.test(key))
        return `${named}: "${key.slice(0, 40)}" isn't a valid variable name.`;
      if (
        typeof value !== "string" ||
        value.length > launchLimits.envValue ||
        value.includes("\0")
      )
        return `${named}: the value of ${key} must be text.`;
    }
  }
  return undefined;
}

/**
 * True for a relative path that stays inside its folder ("web",
 * "./apps/site"); false for absolute paths, drive letters and "..".
 */
export function relativeInside(value: string) {
  if (!value || value.includes("\0")) return false;
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split(/[\\/]+/).filter((part) => part && part !== ".");
  let depth = 0;
  for (const part of parts) {
    depth += part === ".." ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

/** A configuration with only the fields the format defines, trimmed. */
export function cleanEntry(raw: Record<string, unknown>): LaunchEntry {
  const entry: LaunchEntry = { name: String(raw.name).trim() };
  if (typeof raw.runtimeExecutable === "string")
    entry.runtimeExecutable = raw.runtimeExecutable.trim();
  if (Array.isArray(raw.runtimeArgs))
    entry.runtimeArgs = [...(raw.runtimeArgs as string[])];
  if (typeof raw.port === "number") entry.port = raw.port;
  if (typeof raw.url === "string") entry.url = raw.url;
  if (typeof raw.cwd === "string") entry.cwd = raw.cwd;
  if (raw.env && typeof raw.env === "object")
    entry.env = { ...(raw.env as Record<string, string>) };
  return entry;
}

/**
 * Removes // and /* *\/ comments and trailing commas outside strings, so a
 * file written like VS Code's launch.json still reads.
 */
export function stripJsonComments(text: string) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += char;
  }
  return dropTrailingCommas(out);
}

/** Removes commas right before } or ] outside strings. */
function dropTrailingCommas(text: string) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === "," && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    out += char;
  }
  return out;
}

/** Reads a launch.json's text; never throws. */
export function parseLaunchConfig(text: string): LaunchParseResult {
  const empty = (error: string): LaunchParseResult => ({
    configurations: [],
    error,
    extra: {},
    invalid: [],
  });
  if (text.length > launchLimits.fileBytes)
    return empty("launch.json is too large.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    try {
      data = JSON.parse(stripJsonComments(text));
    } catch (error) {
      return empty(
        `launch.json isn't valid JSON (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return empty('launch.json must be an object with "configurations".');
  const { configurations, ...extra } = data as Record<string, unknown>;
  if (configurations === undefined)
    return { configurations: [], extra, invalid: [] };
  if (!Array.isArray(configurations))
    return {
      ...empty('"configurations" in launch.json must be a list.'),
      extra,
    };
  const result: LaunchParseResult = {
    configurations: [],
    extra,
    invalid: [],
    raw: configurations,
  };
  const names = new Set<string>();
  configurations.forEach((raw, index) => {
    let problem = launchEntryProblem(raw, index);
    if (!problem && result.configurations.length >= launchLimits.configurations)
      problem = `launch.json can have at most ${launchLimits.configurations} configurations.`;
    if (!problem) {
      const key = String((raw as { name: string }).name)
        .trim()
        .toLowerCase();
      if (names.has(key))
        problem = `two configurations are named "${(raw as { name: string }).name}".`;
      names.add(key);
    }
    if (problem) {
      result.invalid.push(raw);
      result.error ??= `launch.json: ${problem}`;
      return;
    }
    result.configurations.push(cleanEntry(raw as Record<string, unknown>));
  });
  return result;
}

/**
 * The file text after adding `config`, or replacing the configuration with
 * the same name (case-insensitive). Other configurations, invalid ones
 * included, and other top-level keys stay as they were.
 */
export function upsertLaunchConfig(
  current: LaunchParseResult | undefined,
  config: LaunchEntry,
) {
  const problem = launchEntryProblem(config);
  if (problem) throw new Error(problem);
  const entry = cleanEntry(config as unknown as Record<string, unknown>);
  const key = entry.name.toLowerCase();
  const kept: unknown[] = current?.raw ?? [
    ...(current?.configurations ?? []),
    ...(current?.invalid ?? []),
  ];
  const configurations: unknown[] = [];
  let replaced = false;
  for (const existing of kept) {
    const name =
      existing && typeof existing === "object" && "name" in existing
        ? String((existing as { name: unknown }).name)
            .trim()
            .toLowerCase()
        : "";
    if (name === key) {
      if (!replaced) configurations.push(entry);
      replaced = true;
    } else configurations.push(existing);
  }
  if (!replaced) {
    if ((current?.configurations.length ?? 0) >= launchLimits.configurations)
      throw new Error(
        `launch.json can have at most ${launchLimits.configurations} configurations.`,
      );
    configurations.push(entry);
  }
  const file = {
    version: launchConfigVersion,
    ...(current?.extra ?? {}),
    configurations,
  };
  if (typeof file.version !== "string") file.version = launchConfigVersion;
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * The project's Auto-verify choice, kept in launch.json as `autoVerify`
 * (the original's place for it); undefined when the file has none.
 */
export function launchAutoVerify(result: LaunchParseResult | undefined) {
  const value = result?.extra.autoVerify;
  return typeof value === "boolean" ? value : undefined;
}

/** The file text with `autoVerify` set, everything else as it was. */
export function setLaunchAutoVerify(
  current: LaunchParseResult | undefined,
  on: boolean,
) {
  const configurations: unknown[] = current?.raw ?? [
    ...(current?.configurations ?? []),
    ...(current?.invalid ?? []),
  ];
  const file = {
    version: launchConfigVersion,
    ...(current?.extra ?? {}),
    autoVerify: on,
    configurations,
  };
  if (typeof file.version !== "string") file.version = launchConfigVersion;
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * Splits a command line the way a POSIX shell splits words: spaces
 * separate, single quotes keep everything, double quotes keep spaces, and a
 * backslash escapes the next character. Nothing is expanded, so "$PORT"
 * stays as written. Throws on an unclosed quote.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && /["\\$`]/.test(line[i + 1] ?? "")) {
        word += line[++i];
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("The command has an unclosed quote.");
  if (started) words.push(word);
  return words;
}

/** "npm run dev", quoting words that need it, for showing a command. */
export function formatCommandLine(executable: string, args: string[] = []) {
  return [executable, ...args]
    .map((word) =>
      word === ""
        ? "''"
        : /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
          ? word
          : `'${word.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

/**
 * The part of a configuration a person approves: what runs, where and with
 * which variables. Two configurations with the same key run the same thing.
 */
export function launchCommandKey(
  folder: string,
  entry: Pick<LaunchEntry, "runtimeExecutable" | "runtimeArgs" | "cwd" | "env">,
) {
  const env = Object.entries(entry.env ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify([
    folder,
    entry.cwd ?? ".",
    entry.runtimeExecutable ?? "",
    entry.runtimeArgs ?? [],
    env,
  ]);
}

/**
 * Local addresses a server printed ("Local: http://localhost:5173/"),
 * without ANSI colours; 0.0.0.0 and [::] read as localhost.
 */
export function localUrlsIn(text: string): string[] {
  const plain = stripAnsi(text);
  const found: string[] = [];
  const pattern =
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.localhost):\d{2,5}(?:\/[^\s"'<>)\]]*)?/gi;
  for (const match of plain.matchAll(pattern)) {
    let raw = match[0].replace(/[.,;:]+$/, "");
    raw = raw.replace(/\/\/(?:0\.0\.0\.0|\[::\])(?=:)/, "//localhost");
    try {
      const url = new URL(raw);
      const port = Number(url.port);
      if (port < 1 || port > 65_535) continue;
      const clean = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
      if (!found.includes(clean)) found.push(clean);
    } catch {
      // Not an address.
    }
  }
  return found;
}

/** Text without terminal colour and cursor codes. */
export function stripAnsi(text: string) {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}
