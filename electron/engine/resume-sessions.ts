import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Conversation, Turn } from "../../shared/types";
import type { ResumableSession } from "../../shared/resume-sessions";

interface NativeThread {
  id: string;
  name?: string;
  preview?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  gitInfo?: { branch?: string };
  status?: { type: string };
  turns?: { id: string; status: string; items: Record<string, any>[] }[];
}

export function resumeTurns(thread: NativeThread): Turn[] {
  return (thread.turns ?? []).map((turn) => ({
    id: turn.id,
    prompt: turn.items
      .filter((item) => item.type === "userMessage")
      .flatMap((item) =>
        (item.content ?? [])
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text),
      )
      .join("\n"),
    attachments: [],
    items: turn.items
      .filter((item) => item.type !== "userMessage")
      .map((item) => ({ ...item, id: item.id, type: item.type })),
    status:
      turn.status === "failed" || turn.status === "interrupted"
        ? "failed"
        : "completed",
    createdAt: thread.createdAt * 1000,
  }));
}

/** Opaque handles and fresh liveness checks. */
export class ResumeSessions {
  private handles = new Map<string, string>();
  private scope?: string;
  constructor(
    private options: {
      request(
        method: "thread/list" | "thread/read",
        params: object,
      ): Promise<any>;
      conversations(): Conversation[];
      allowFolder(cwd: string): void;
      scope?(): string;
    },
  ) {}

  private checkScope() {
    const scope = this.options.scope?.();
    if (scope !== this.scope) {
      this.scope = scope;
      this.handles.clear();
    }
  }

  private owned(id: string) {
    return this.options
      .conversations()
      .some(
        (conversation) =>
          conversation.threadId === id ||
          conversation.savedBranches?.some((branch) => branch.threadId === id),
      );
  }

  async list(): Promise<ResumableSession[]> {
    this.checkScope();
    const scope = this.scope;
    const sessions: ResumableSession[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.options.request("thread/list", {
        limit: 100,
        cursor,
        archived: false,
      });
      this.checkScope();
      if (scope !== this.scope)
        throw new Error("Couldn’t load your Claudex Code sessions.");
      for (const thread of response.data as NativeThread[]) {
        if (
          !thread.id ||
          !thread.cwd ||
          this.owned(thread.id) ||
          thread.status?.type === "active"
        )
          continue;
        let handle = [...this.handles].find(([, id]) => id === thread.id)?.[0];
        if (!handle) {
          handle = randomUUID();
          this.handles.set(handle, thread.id);
        }
        const exists = await stat(thread.cwd).then(
          (info) => info.isDirectory(),
          () => false,
        );
        let trusted = true;
        try {
          this.options.allowFolder(thread.cwd);
        } catch {
          trusted = false;
        }
        sessions.push({
          handle,
          title: trusted
            ? thread.name || thread.preview || undefined
            : undefined,
          cwd: thread.cwd,
          gitBranch: trusted ? thread.gitInfo?.branch : undefined,
          lastActivityAt: thread.updatedAt * 1000,
          folderMissing: !exists || !trusted || undefined,
          liveness:
            thread.status && ["idle", "notLoaded"].includes(thread.status.type)
              ? "closed"
              : "unknown",
        });
      }
      cursor = response.nextCursor || undefined;
    } while (cursor && sessions.length < 1000);
    this.checkScope();
    if (scope !== this.scope)
      throw new Error("Couldn’t load your Claudex Code sessions.");
    return sessions.sort(
      (first, second) => second.lastActivityAt - first.lastActivityAt,
    );
  }

  async read(handle: string, resuming = false) {
    this.checkScope();
    const scope = this.scope;
    const id = this.handles.get(handle);
    if (!id || this.owned(id)) throw new Error("Couldn’t resume that session.");
    const { thread } = (await this.options.request("thread/read", {
      threadId: id,
      includeTurns: true,
    })) as { thread: NativeThread };
    this.checkScope();
    if (scope !== this.scope) throw new Error("Couldn’t resume that session.");
    if (thread.id !== id || thread.status?.type === "active")
      throw new Error("Couldn’t resume that session.");
    this.options.allowFolder(thread.cwd);
    if (resuming) {
      if (
        !(await stat(thread.cwd).then(
          (info) => info.isDirectory(),
          () => false,
        ))
      )
        throw new Error("Folder not found");
      if (!thread.status || !["idle", "notLoaded"].includes(thread.status.type))
        throw new Error("Can’t confirm it’s closed");
    }
    this.checkScope();
    if (scope !== this.scope) throw new Error("Couldn’t resume that session.");
    return thread;
  }
}
