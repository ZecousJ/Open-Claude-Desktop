import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SshToolGrant } from "../../shared/ssh-api";

// Host-scoped connector grants.
export function sshServerKey(server: Record<string, unknown>) {
  const { tools, ...config } = server;
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export class SshToolGrantStore {
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, "ssh-tool-grants.json");
  }

  list(): SshToolGrant[] {
    try {
      const entries: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(entries)) return [];
      return entries
        .filter(
          (entry): entry is SshToolGrant =>
            entry &&
            [
              "endpointKey",
              "server",
              "toolName",
              "hostLabel",
              "serverLabel",
              "toolLabel",
              "serverKey",
              "hostKey",
            ].every((key) => typeof entry[key] === "string") &&
            Number.isFinite(entry.grantedAt),
        )
        .sort((first, second) => second.grantedAt - first.grantedAt);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      )
        return [];
      throw error;
    }
  }

  private write(entries: SshToolGrant[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  allows(
    endpointKey: string,
    server: string,
    toolName: string,
    serverKey: string,
    hostKey: string,
  ) {
    return this.list().some(
      (entry) =>
        entry.endpointKey === endpointKey &&
        entry.server === server &&
        entry.toolName === toolName &&
        entry.serverKey === serverKey &&
        entry.hostKey === hostKey,
    );
  }

  grant(entry: SshToolGrant) {
    this.write([
      ...this.list().filter(
        (current) =>
          !this.matches(
            current,
            entry.endpointKey,
            entry.server,
            entry.toolName,
          ),
      ),
      entry,
    ]);
  }

  private matches(
    entry: SshToolGrant,
    endpointKey: string,
    server: string,
    toolName: string,
  ) {
    return (
      entry.endpointKey === endpointKey &&
      entry.server === server &&
      entry.toolName === toolName
    );
  }

  remove(endpointKey: string, server: string, toolName: string) {
    this.write(
      this.list().filter(
        (entry) => !this.matches(entry, endpointKey, server, toolName),
      ),
    );
  }

  clear() {
    this.write([]);
  }
}
