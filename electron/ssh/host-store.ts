/**
 * The SSH hosts the person added (R9), kept in `<dataRoot>/ssh-hosts.json`
 * (mode 0600, written atomically). Only connection details are stored:
 * never a password, a passphrase or a key.
 *
 * Every entry is checked on its own when the file is read, so one broken
 * entry (edited by hand, or from an older build) is skipped and the other
 * connections still show.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SshHost, SshHostInput } from "../../shared/ssh-api";
import { checkRemotePath } from "./remote-scripts";

export const HOSTS_FILE = "ssh-hosts.json";
export const MAX_HOSTS = 100;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A host id: letters, digits, "-" and "_", at most 64. */
export function checkHostId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new Error("Unknown SSH connection.");
  return value;
}

/**
 * "alias", "host", "user@host" or "user@[v6::addr]": no leading "-" (it
 * would read as an ssh option), no whitespace, quotes, backslashes or
 * control characters, at most 255 characters.
 */
export function checkDestination(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a host.");
  const destination = value.trim();
  if (!destination) throw new Error("Enter a host.");
  if (destination.length > 255) throw new Error("The host name is too long.");
  if (destination.startsWith("-"))
    throw new Error("A host can't start with “-”.");
  if (/[\s"'`\\]/.test(destination) || CONTROL.test(destination))
    throw new Error(
      "Enter a host like user@hostname, or a Host name from your SSH config.",
    );
  const at = destination.lastIndexOf("@");
  if (at === 0 || at === destination.length - 1)
    throw new Error(
      "Enter a host like user@hostname, or a Host name from your SSH config.",
    );
  return destination;
}

export function checkPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const port = typeof value === "string" ? Number(value) : value;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Enter a port from 1 to 65535.");
  return port;
}

/** A local path (only the path; the key itself is never read). */
export function checkIdentityFile(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 1024 || CONTROL.test(value))
    throw new Error("Choose the identity file again.");
  if (!(
    value.startsWith("~/") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ))
    throw new Error("Enter the full path to the identity file.");
  return value;
}

function checkLabel(value: unknown, destination: string): string {
  if (value === undefined || value === null) return destination;
  if (typeof value !== "string") throw new Error("Enter a name.");
  const label = value.trim().replace(/\s+/g, " ");
  if (label.length > 100) throw new Error("The name is too long.");
  if (CONTROL.test(label)) throw new Error("Enter a name.");
  return label || destination;
}

function optionalRemotePath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return checkRemotePath(value);
}

function checkTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The fields of a host as the person entered them, checked. `sshPath` is
 * checked by the caller (it must exist on this computer, see
 * `checkCustomSsh`), here only its shape.
 */
export function checkHostFields(input: unknown) {
  if (!input || typeof input !== "object")
    throw new Error("Enter the connection details.");
  const value = input as Record<string, unknown>;
  const destination = checkDestination(value.destination);
  let sshPath: string | undefined;
  if (
    value.sshPath !== undefined &&
    value.sshPath !== null &&
    value.sshPath !== ""
  ) {
    if (
      typeof value.sshPath !== "string" ||
      value.sshPath.length > 1024 ||
      CONTROL.test(value.sshPath)
    )
      throw new Error("Choose the ssh program.");
    sshPath = value.sshPath;
  }
  return {
    label: checkLabel(value.label, destination),
    destination,
    port: checkPort(value.port),
    identityFile: checkIdentityFile(value.identityFile),
    remoteRoot: optionalRemotePath(value.remoteRoot),
    defaultFolder: optionalRemotePath(value.defaultFolder),
    sshPath,
    forwardAgent: value.forwardAgent === true ? true : undefined,
  };
}

/** A stored entry, or undefined when any part of it is wrong. */
export function parseStoredHost(value: unknown): SshHost | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const entry = value as Record<string, unknown>;
    const id = checkHostId(entry.id);
    const createdAt = checkTime(entry.createdAt);
    if (createdAt === undefined) return undefined;
    return compact({
      id,
      ...checkHostFields(entry),
      createdAt,
      lastUsedAt: checkTime(entry.lastUsedAt),
    });
  } catch {
    return undefined;
  }
}

/** Drops the fields that are undefined, so the file stays small. */
function compact(host: SshHost): SshHost {
  return Object.fromEntries(
    Object.entries(host).filter(([, v]) => v !== undefined),
  ) as unknown as SshHost;
}

export class SshHostStore {
  private hosts: SshHost[] = [];
  /** How many entries the file had that could not be read. */
  skipped = 0;
  private readonly file: string;

  constructor(
    dataRoot: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dataRoot, HOSTS_FILE);
    this.load();
  }

  private load() {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn("SSH connections file couldn't be read.");
      return;
    }
    const entries =
      raw && typeof raw === "object" && Array.isArray((raw as any).hosts)
        ? ((raw as any).hosts as unknown[])
        : [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const host = parseStoredHost(entry);
      if (!host || seen.has(host.id) || this.hosts.length >= MAX_HOSTS) {
        this.skipped++;
        continue;
      }
      seen.add(host.id);
      this.hosts.push(host);
    }
    // Only the count: host names and users stay out of logs.
    if (this.skipped)
      console.warn(`Skipped ${this.skipped} unreadable SSH connection(s).`);
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, hosts: this.hosts }, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Windows has no POSIX modes; the profile folder is per user.
    }
  }

  list(): SshHost[] {
    return this.hosts.map((host) => ({ ...host }));
  }

  get(id: string): SshHost | undefined {
    const host = this.hosts.find((item) => item.id === id);
    return host && { ...host };
  }

  /** Adds a host, or changes the one with `input.id`. */
  save(input: SshHostInput): SshHost {
    const fields = checkHostFields(input);
    if (input.id !== undefined) {
      const id = checkHostId(input.id);
      const index = this.hosts.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("That SSH connection no longer exists.");
      const current = this.hosts[index];
      const host = compact({
        ...fields,
        id,
        createdAt: current.createdAt,
        lastUsedAt: current.lastUsedAt,
      });
      this.hosts[index] = host;
      this.persist();
      return { ...host };
    }
    if (this.hosts.length >= MAX_HOSTS)
      throw new Error(`You can save up to ${MAX_HOSTS} SSH connections.`);
    const host = compact({
      ...fields,
      id: randomUUID(),
      createdAt: this.now(),
    });
    this.hosts.push(host);
    this.persist();
    return { ...host };
  }

  delete(id: string): boolean {
    const before = this.hosts.length;
    this.hosts = this.hosts.filter((item) => item.id !== id);
    if (this.hosts.length === before) return false;
    this.persist();
    return true;
  }

  /** Notes that the host was just connected to (for ordering). */
  touch(id: string) {
    const host = this.hosts.find((item) => item.id === id);
    if (!host) return;
    host.lastUsedAt = this.now();
    this.persist();
  }
}
