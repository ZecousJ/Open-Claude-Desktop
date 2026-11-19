import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Conversation, Turn } from "../../shared/types";
import {
  CliResumeError,
  type ResumableSession,
} from "../../shared/resume-sessions";

interface NativeThread {
  id: string;
  name?: string;
  preview?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  parentThreadId?: string | null;
  ephemeral?: boolean;
  gitInfo?: { branch?: string };
  status?: { type: string };
  turns?: {
    id: string;
    status: string;
    startedAt?: number | null;
    error?: { message?: string } | null;
    items: Record<string, any>[];
  }[];
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
      turn.status === "interrupted" || turn.status === "failed"
        ? turn.status
        : "completed",
    createdAt: (turn.startedAt ?? thread.createdAt) * 1000,
    ...(turn.error?.message && { error: turn.error.message }),
  }));
}

/** Opaque handles and fresh liveness checks (desktop 2.37337.1, index.chunk-DQOJOjYy). */
export class ResumeSessions {
  private handles = new Map<string, string>();
  private scope?: unknown;
  constructor(
    private options: {
      request(
        method: "thread/list" | "thread/read",
        params: object,
      ): Promise<any>;
      conversations(): Conversation[];
      allowFolder(cwd: string): void;
      scope?(): unknown;
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
  existing(handle: string) {
    this.checkScope();
    const id = this.handles.get(handle);
    return id
      ? this.options.conversations().find((row) => row.threadId === id)
      : undefined;
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
        modelProviders: [],
        sourceKinds: ["cli", "exec", "appServer", "vscode"],
        sortKey: "updated_at",
      });
      this.checkScope();
      if (scope !== this.scope)
        throw new Error("Couldn’t load your Claudex Code sessions.");
      for (const thread of response.data as NativeThread[]) {
        if (
          !thread.id ||
          !thread.cwd ||
          thread.parentThreadId ||
          thread.ephemeral ||
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
        this.checkScope();
        if (scope !== this.scope)
          throw new Error("Couldn’t load your Claudex Code sessions.");
        if (this.owned(thread.id)) continue;
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
          folderMissing: !exists || undefined,
          workspaceUntrusted: !trusted || undefined,
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
    if (thread.id !== id) throw new Error("Couldn’t resume that session.");
    if (thread.status?.type === "active")
      throw new CliResumeError(
        "running",
        "Couldn’t resume that session while it is running.",
      );
    if (resuming) {
      if (
        !(await stat(thread.cwd).then(
          (info) => info.isDirectory(),
          () => false,
        ))
      )
        throw new CliResumeError("folder_missing", "Folder not found");
      if (!thread.status || !["idle", "notLoaded"].includes(thread.status.type))
        throw new CliResumeError(
          "liveness_unknown",
          "Can’t confirm it’s closed",
        );
    }
    try {
      this.options.allowFolder(thread.cwd);
    } catch (error) {
      throw new CliResumeError(
        "workspace_untrusted",
        error instanceof Error ? error.message : "Workspace not trusted",
      );
    }
    this.checkScope();
    if (scope !== this.scope || this.owned(id))
      throw new Error("Couldn’t resume that session.");
    return thread;
  }
}
