/**
 * Saved SSH passwords. Each is encrypted with AES-256-GCM under a key derived
 * from the app's vault key (itself kept by the OS keychain,
 * provider-credentials.ts) in <dataRoot>/ssh-passwords.json, one entry per
 * saved host. Without OS encryption they live in memory until the app quits. A
 * password only ever reaches ssh through the askpass broker; the window learns
 * whether a host has one, never the password.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_SSH_PASSWORD = 1024;

/** A password as the form may send it: text without line breaks. */
export function checkSshPassword(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_SSH_PASSWORD)
    throw new Error("Enter a password of at most 1024 characters.");
  if (/[\r\n\0]/.test(value))
    throw new Error("The password can't contain a line break.");
  return value;
}

type Entry = { iv: string; tag: string; data: string };

export class SshPasswordStore {
  private memory = new Map<string, string>();
  private readonly file: string;
  constructor(
    dataRoot: string,
    /** The vault key, or "" when nothing can be saved to disk. */
    private vaultKey: () => string,
  ) {
    this.file = path.join(dataRoot, "ssh-passwords.json");
  }

  private key() {
    const vault = this.vaultKey();
    return vault
      ? createHash("sha256").update(`claudex-ssh-passwords\0${vault}`).digest()
      : undefined;
  }

  private read(): Record<string, Entry> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  private write(entries: Record<string, Entry>) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  has(hostId: string) {
    return this.memory.has(hostId) || Boolean(this.read()[hostId]);
  }

  get(hostId: string): string | undefined {
    const held = this.memory.get(hostId);
    if (held !== undefined) return held;
    const entry = this.read()[hostId];
    const key = this.key();
    if (!entry || !key) return undefined;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(entry.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Another vault key (a reinstalled app): as if none was saved.
      return undefined;
    }
  }

  set(hostId: string, password: string) {
    const key = this.key();
    const entries = this.read();
    if (!key) {
      this.memory.set(hostId, password);
      if (entries[hostId]) {
        delete entries[hostId];
        this.write(entries);
      }
      return;
    }
    this.memory.delete(hostId);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
      cipher.update(password, "utf8"),
      cipher.final(),
    ]);
    entries[hostId] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    this.write(entries);
  }

  delete(hostId: string) {
    this.memory.delete(hostId);
    const entries = this.read();
    if (!entries[hostId]) return;
    delete entries[hostId];
    this.write(entries);
  }
}
