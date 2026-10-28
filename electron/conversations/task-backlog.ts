import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  BackgroundTaskSuggestion,
  TaskBacklogItem,
} from "../../shared/task-backlog";

const item = z
  .object({
    id: z.string().regex(/^todo_[0-9a-f]{12}$/),
    cwd: z.string().min(1).max(4096),
    source: z.enum(["dismissed", "evicted", "orphaned"]),
    title: z.string().max(200),
    tldr: z.string().max(4096).optional(),
    prompt: z.string().min(1).max(200000),
    suggestedAt: z.number().finite().nonnegative(),
    filedAt: z.number().finite().nonnegative(),
    originSessionId: z.string().min(1).max(500),
    originTaskId: z.string().min(1).max(500),
  })
  .strict();
type Entry = z.infer<typeof item>;
const lifetime = 30 * 86400000;

/** Thirty-day retention, 20 per folder and 100 total. */
export class TaskBacklog {
  constructor(
    private root: string,
    private now = Date.now,
  ) {}
  private filename() {
    return path.join(this.root, "task-backlog.json");
  }
  private entries(): Entry[] {
    try {
      if (fs.statSync(this.filename()).size > 32 * 1024 * 1024)
        throw new Error();
      const entries = z
        .array(item)
        .max(4096)
        .parse(JSON.parse(fs.readFileSync(this.filename(), "utf8")));
      return entries.filter(
        (entry) => this.now() - entry.suggestedAt < lifetime,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Task backlog unavailable; try again");
    }
  }
  private save(entries: Entry[]) {
    const temporary = `${this.filename()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, this.filename());
  }
  private folder(cwd: string) {
    const full = path.normalize(cwd);
    const stripped = full.replace(/[/\\]+$/, "");
    const normalized =
      !stripped || /^[A-Za-z]:$/.test(stripped) ? full : stripped;
    return process.platform === "linux"
      ? normalized
      : normalized.normalize("NFC").toLowerCase();
  }
  list(cwd: string, limit = 20): TaskBacklogItem[] {
    return this.entries()
      .filter((entry) => this.folder(entry.cwd) === this.folder(cwd))
      .sort((first, second) => second.filedAt - first.filedAt)
      .slice(0, limit)
      .map(
        ({ originSessionId: _session, originTaskId: _task, ...entry }) => entry,
      );
  }
  file(
    sessionId: string,
    suggestion: BackgroundTaskSuggestion,
    source: Entry["source"],
  ) {
    const entries = this.entries();
    if (
      entries.some(
        (entry) =>
          entry.originSessionId === sessionId &&
          entry.originTaskId === suggestion.id,
      )
    )
      return;
    const now = this.now();
    if (now - suggestion.createdAt >= lifetime) return;
    entries.push(
      item.parse({
        id: `todo_${randomBytes(6).toString("hex")}`,
        cwd: suggestion.cwd,
        title: suggestion.title.slice(0, 200),
        tldr: suggestion.tldr,
        prompt: suggestion.prompt,
        suggestedAt: suggestion.createdAt,
        filedAt: now,
        source,
        originSessionId: sessionId,
        originTaskId: suggestion.id,
      }),
    );
    const folders = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = this.folder(entry.cwd);
      folders.set(key, [...(folders.get(key) ?? []), entry]);
    }
    const trim = (values: Entry[], cap: number) => {
      while (values.length > cap) {
        const index = values.findIndex(
          (entry) => entry.source !== "dismissed" && entry.filedAt !== now,
        );
        const fallback = values.findIndex(
          (entry) => entry.source !== "dismissed",
        );
        const older = values.findIndex((entry) => entry.filedAt !== now);
        values.splice(
          index >= 0
            ? index
            : fallback >= 0
              ? fallback
              : older >= 0
                ? older
                : 0,
          1,
        );
      }
      return values;
    };
    this.save(
      trim(
        [...folders.values()]
          .flatMap((values) => trim(values, 20))
          .sort((first, second) => first.filedAt - second.filedAt),
        100,
      ),
    );
  }
  dismiss(id: string) {
    const entries = this.entries();
    if (!entries.some((entry) => entry.id === id)) return false;
    this.save(entries.filter((entry) => entry.id !== id));
    return true;
  }
  withdraw(sessionId: string, taskId: string) {
    const entries = this.entries();
    const remaining = entries.filter(
      (entry) =>
        entry.originSessionId !== sessionId || entry.originTaskId !== taskId,
    );
    if (remaining.length === entries.length) return false;
    this.save(remaining);
    return true;
  }
}
