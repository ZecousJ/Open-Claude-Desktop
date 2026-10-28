/**
 * The person's own ssh configuration, read the way ssh reads it (R9).
 *
 * - `effectiveConfig` asks ssh itself (`ssh -G`) what a destination
 *   resolves to: host name, user, port, jump host. Nothing connects.
 * - `configHostSuggestions` offers the plain `Host` names from
 *   ~/.ssh/config (and the files it includes) in the Add connection
 *   dialog. Only Host lines are read; keys and known_hosts never are.
 *
 * Reading the person's ssh configuration at run time is the feature itself;
 * tests always point `home` at a temporary folder.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EffectiveSshConfig {
  hostname?: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyJump?: string;
  forwardAgent?: boolean;
  userKnownHostsFiles?: string[];
  strictHostKeyChecking?: string;
  hostKeyAlias?: string;
}

/** Reads `ssh -G` output ("key value" per line, keys in lower case). */
export function parseSshG(output: string): EffectiveSshConfig {
  const config: EffectiveSshConfig = { identityFiles: [] };
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    const space = line.indexOf(" ");
    if (space < 1) continue;
    const key = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1).trim();
    if (!value) continue;
    switch (key) {
      case "hostname":
        config.hostname = value;
        break;
      case "user":
        config.user = value;
        break;
      case "port": {
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port < 65536)
          config.port = port;
        break;
      }
      case "identityfile":
        config.identityFiles.push(value);
        break;
      case "proxyjump":
        if (value !== "none") config.proxyJump = value;
        break;
      case "forwardagent":
        config.forwardAgent = value !== "no";
        break;
      case "userknownhostsfile":
        config.userKnownHostsFiles = value.split(/\s+/);
        break;
      case "stricthostkeychecking":
        config.strictHostKeyChecking = value;
        break;
      case "hostkeyalias":
        if (value !== "none") config.hostKeyAlias = value;
        break;
    }
  }
  return config;
}

/** What ssh would use for a destination (`ssh -G`); undefined when it fails. */
export function effectiveConfig(
  sshPath: string,
  destination: string,
  port?: number,
): Promise<EffectiveSshConfig | undefined> {
  const args = ["-G", ...(port ? ["-p", String(port)] : []), "--"];
  return new Promise((resolve) => {
    execFile(
      sshPath,
      [...args, destination],
      { timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve(error ? undefined : parseSshG(stdout)),
    );
  });
}

/** A Host name worth suggesting: no pattern, no negation. */
function plainHostName(name: string) {
  return !/[*?!]/.test(name) && !name.startsWith("-") && name.length <= 255;
}

/** "Keyword value" or "Keyword=value", with the keyword in lower case. */
function directive(line: string): [string, string] | undefined {
  const match = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$/.exec(line);
  return match ? [match[1].toLowerCase(), match[2]] : undefined;
}

/** Splits ssh config arguments, keeping "quoted words" together. */
function words(value: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (let match = pattern.exec(value); match; match = pattern.exec(value))
    out.push(match[1] ?? match[2]);
  return out;
}

/** The files an Include names (relative ones are under ~/.ssh; "*" and "?" in the last part). */
function includedFiles(pattern: string, home: string): string[] {
  const expanded = pattern.startsWith("~/")
    ? path.join(home, pattern.slice(2))
    : path.isAbsolute(pattern)
      ? pattern
      : path.join(home, ".ssh", pattern);
  const dir = path.dirname(expanded);
  const base = path.basename(expanded);
  if (/[*?]/.test(dir)) return [];
  if (!/[*?]/.test(base)) return [expanded];
  const regex = new RegExp(
    `^${base
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => regex.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * The plain Host names in ~/.ssh/config and the files it includes (up to
 * four levels, 200 names), in the order they appear, without duplicates.
 */
export function configHostSuggestions(home = os.homedir()): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const read = (file: string, depth: number) => {
    if (depth > 4 || visited.has(file) || names.length >= 200) return;
    visited.add(file);
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return;
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const parsed = directive(line);
      if (!parsed) continue;
      const [keyword, value] = parsed;
      if (keyword === "include") {
        for (const pattern of words(value))
          for (const included of includedFiles(pattern, home))
            read(included, depth + 1);
      } else if (keyword === "host") {
        for (const name of words(value))
          if (plainHostName(name) && !seen.has(name) && names.length < 200) {
            seen.add(name);
            names.push(name);
          }
      }
    }
  };
  read(path.join(home, ".ssh", "config"), 0);
  return names;
}
