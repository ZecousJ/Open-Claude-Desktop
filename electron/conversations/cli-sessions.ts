import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import type { ResumableSession } from "../../shared/resume-sessions";
import { claudeTurns } from "./claude-transcripts";

interface Transcript {
  file: string;
  realFile: string;
  sessionId: string;
  device: number;
  inode: number;
}
const maxBytes = 64 * 1024 * 1024;
const validId = /^[A-Za-z0-9_-]{1,200}$/;

/** Opaque handles, registry liveness and fresh file identity checks. */
export class CliSessions {
  private handles = new Map<string, Transcript>();
  private scope?: string;
  constructor(
    private options: {
      conversations(): Conversation[];
      scope(): string;
      allowFolder(cwd: string): void;
      configDir?: string | (() => string | undefined);
      processAlive?(pid: number): boolean;
    },
  ) {}

  private configDir() {
    const configured =
      typeof this.options.configDir === "function"
        ? this.options.configDir()
        : this.options.configDir;
    return (
      configured ??
      process.env.CLAUDE_CONFIG_DIR ??
      path.join(os.homedir(), ".claude")
    );
  }
  private checkScope() {
    const scope = this.options.scope();
    if (scope !== this.scope) {
      this.scope = scope;
      this.handles.clear();
    }
  }
  owns(handle: string) {
    this.checkScope();
    return this.handles.has(handle);
  }
  private owned(sessionId: string) {
    return this.options
      .conversations()
      .some((entry) => entry.importedCliSessionId === sessionId);
  }
  private async running(sessionId: string) {
    const directory = path.join(this.configDir(), "sessions");
    const entries = await fs.readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of entries.filter((entry) => /^\d+\.json$/.test(entry))) {
      const pid = Number(name.slice(0, -5));
      let alive = false;
      try {
        if (this.options.processAlive) alive = this.options.processAlive(pid);
        else {
          process.kill(pid, 0);
          alive = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
      }
      if (!alive) continue;
      const file = await fs.open(
        path.join(directory, name),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let entry;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
          throw new Error("Can’t confirm it’s closed");
        const text = await file.readFile("utf8");
        if (Buffer.byteLength(text) > 65536)
          throw new Error("Can’t confirm it’s closed");
        entry = JSON.parse(text);
      } finally {
        await file.close();
      }
      if (entry.pid !== pid || typeof entry.sessionId !== "string")
        throw new Error("Can’t confirm it’s closed");
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }
  private async transcript(entry: Transcript) {
    if ((await fs.realpath(entry.file)) !== entry.realFile)
      throw new Error("Couldn’t resume that session.");
    const file = await fs.open(
      entry.file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > maxBytes ||
        stat.dev !== entry.device ||
        stat.ino !== entry.inode
      )
        throw new Error("Couldn’t resume that session.");
      const text = await file.readFile("utf8");
      if ((await fs.realpath(entry.file)) !== entry.realFile)
        throw new Error("Couldn’t resume that session.");
      if (Buffer.byteLength(text) > maxBytes)
        throw new Error("Couldn’t resume that session.");
      const messages = text.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const current = messages.filter(
        (message) => message && message.sessionId === entry.sessionId,
      );
      const cwd = current.find(
        (message) => typeof message.cwd === "string",
      )?.cwd;
      if (!cwd || !path.isAbsolute(cwd)) throw new Error("Folder not found");
      this.options.allowFolder(cwd);
      const turns = claudeTurns(current);
      const title =
        [...current]
          .reverse()
          .find((message) => typeof message.customTitle === "string")
          ?.customTitle ??
        turns
          .find((turn) => turn.prompt)
          ?.prompt.split("\n")[0]
          .slice(0, 200);
      const branch = [...current]
        .reverse()
        .find((message) => typeof message.gitBranch === "string")?.gitBranch;
      return { cwd, turns, title, branch, modifiedAt: stat.mtimeMs };
    } finally {
      await file.close();
    }
  }
  async list(): Promise<ResumableSession[]> {
    this.checkScope();
    const scope = this.scope;
    const directory = path.join(this.configDir(), "projects");
    const projects = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const rows: ResumableSession[] = [];
    for (const project of projects.filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
    )) {
      const folder = path.join(directory, project.name);
      for (const file of await fs.readdir(folder, { withFileTypes: true })) {
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          !file.name.endsWith(".jsonl")
        )
          continue;
        const sessionId = file.name.slice(0, -6);
        if (!validId.test(sessionId) || this.owned(sessionId)) continue;
        const filename = path.join(folder, file.name);
        try {
          const stat = await fs.lstat(filename);
          const entry = {
            file: filename,
            realFile: await fs.realpath(filename),
            sessionId,
            device: stat.dev,
            inode: stat.ino,
          };
          if (await this.running(sessionId)) continue;
          const transcript = await this.transcript(entry);
          if (!transcript.turns.length) continue;
          const folderMissing = !(await fs.stat(transcript.cwd).then(
            (info) => info.isDirectory(),
            () => false,
          ));
          this.checkScope();
          if (scope !== this.scope) return [];
          let handle = [...this.handles].find(
            ([, value]) => value.file === filename,
          )?.[0];
          if (!handle) handle = randomUUID();
          this.handles.set(handle, entry);
          rows.push({
            handle,
            cwd: transcript.cwd,
            title: transcript.title,
            gitBranch: transcript.branch,
            lastActivityAt: transcript.modifiedAt,
            folderMissing: folderMissing || undefined,
            liveness: "closed",
          });
        } catch {
          /* Untrusted, live, unreadable and aliased transcripts are not offered. */
        }
        if (rows.length >= 1000) break;
      }
      if (rows.length >= 1000) break;
    }
    const offered = new Set(rows.map((entry) => entry.handle));
    for (const handle of this.handles.keys())
      if (!offered.has(handle)) this.handles.delete(handle);
    return rows.sort(
      (first, second) => second.lastActivityAt - first.lastActivityAt,
    );
  }
  async read(handle: string, resuming = false) {
    this.checkScope();
    const scope = this.scope;
    const entry = this.handles.get(handle);
    if (
      !entry ||
      this.owned(entry.sessionId) ||
      (await this.running(entry.sessionId))
    )
      throw new Error("Couldn’t resume that session.");
    const transcript = await this.transcript(entry);
    if (
      resuming &&
      !(await fs.stat(transcript.cwd).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      throw new Error("Folder not found");
    this.checkScope();
    const running = await this.running(entry.sessionId);
    this.checkScope();
    if (scope !== this.scope || this.owned(entry.sessionId) || running)
      throw new Error("Couldn’t resume that session.");
    return { ...transcript, sessionId: entry.sessionId };
  }
}
