/**
 * The memory summary task (R3 design 3.6): reads the conversations that are
 * new since the last run and rewrites the memory documents from them, and
 * merges memory imported from another assistant into the global document.
 *
 * Privacy: nothing runs unless memory is on ("Generate memory from chats"
 * allowed by the policy and switched on by the person); incognito chats and
 * Code sessions are never read; credential-shaped text is replaced before a
 * digest leaves the process; the digests go only to the configured model
 * provider through this computer's gateway.
 *
 * Progress is kept in `memory-cursor.json` in the profile (0600): for each
 * conversation the `updatedAt` last read, so a chat is read again only when
 * it changed. The file is per computer: another device only reads its own
 * chats.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Conversation } from "../../shared/types";
import type { MemoryStatus } from "../../shared/memory-api";
import {
  candidates,
  nextBatch,
  redactSecrets,
  scopesWithNews,
  type Batch,
  type MemoryCursor,
} from "./digest";
import type { Completer } from "./completion";
import {
  alreadyContains,
  dedupeLines,
  importPrompt,
  readMemoryAnswer,
  synthesisPrompt,
} from "./prompts";
import { MemoryConflictError } from "./store";
import type { MemoryRunState, MemoryService } from "./service";
import { maxImportBytes, memoryMessages, utf8Bytes } from "./types";

export const memoryCursorFile = "memory-cursor.json";

/** Most batches one run reads for a scope; the rest wait for the next run. */
export const batchesPerRun = 3;

const cursorSchema = z.object({
  version: z.literal(1),
  cursors: z.record(z.string().max(200), z.number().nonnegative()),
  lastAttemptAt: z.number().nonnegative().optional(),
  lastRun: z
    .object({
      at: z.number().nonnegative(),
      ok: z.boolean(),
      message: z.string().max(400).optional(),
    })
    .optional(),
});
type CursorFile = z.infer<typeof cursorSchema>;

export interface RunResult {
  /**
   * done: memory was updated; nothing: no new conversations; skipped: memory
   * is off or cannot be written; failed: the model or the store refused.
   */
  status: "done" | "nothing" | "skipped" | "failed";
  message?: string;
  /** Conversations read in this run. */
  conversations: number;
  /** More conversations wait for another run. */
  more: boolean;
}

export interface SynthesizerDeps {
  service: MemoryService;
  /** The signed-in account's conversations on this computer. */
  conversations(): readonly Conversation[];
  complete: Completer;
  /** The profile folder (`memory-cursor.json` lives in it). */
  root: string;
  now?(): number;
}

const skipped = (message: string): RunResult => ({
  status: "skipped",
  message,
  conversations: 0,
  more: false,
});

/** A model or network failure as a sentence for the person. */
function reason(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown error.";
}

export class MemorySynthesizer {
  private file: CursorFile | undefined;
  private running: Promise<RunResult> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private readonly now: () => number;
  constructor(private deps: SynthesizerDeps) {
    this.now = deps.now ?? Date.now;
    deps.service.setRunState(() => this.state());
  }

  private get path() {
    return path.join(this.deps.root, memoryCursorFile);
  }

  private load(): CursorFile {
    if (this.file) return this.file;
    try {
      const parsed = cursorSchema.safeParse(
        JSON.parse(fs.readFileSync(this.path, "utf8")),
      );
      this.file = parsed.success ? parsed.data : { version: 1, cursors: {} };
    } catch {
      // No file yet, or a file that is not readable: start over. It holds
      // only where reading stopped, so the cost is reading chats again.
      this.file = { version: 1, cursors: {} };
    }
    return this.file;
  }

  private save() {
    const file = this.load();
    const tmp = `${this.path}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(tmp, this.path);
    } catch (error) {
      console.error("Memory progress could not be saved:", reason(error));
    }
  }

  /** What the Settings page shows about the task. */
  state(): MemoryRunState {
    const { lastRun } = this.load();
    return {
      synthesizing: !!this.running,
      ...(lastRun ? { lastRun: { ...lastRun } } : {}),
    };
  }

  /** When the task last looked for something new (a run that found nothing counts). */
  lastAttemptAt() {
    return this.load().lastAttemptAt ?? 0;
  }

  /** Whether the last run that read chats failed. */
  lastRunFailed() {
    return this.load().lastRun?.ok === false;
  }

  /** Runs once; a call during a run joins it. */
  run(): Promise<RunResult> {
    if (this.stopped) return Promise.resolve(skipped("Memory is stopped."));
    this.running ??= this.execute().finally(() => {
      this.running = undefined;
      this.controller = undefined;
      this.deps.service.announce();
    });
    return this.running;
  }

  /** Cancels a running summary and stops taking new ones (sign-out). */
  stop() {
    this.stopped = true;
    this.controller?.abort();
    this.deps.service.setRunState(undefined);
  }

  private off(): string | undefined {
    const { service } = this.deps;
    if (!service.effective().generate) {
      const status: MemoryStatus = service.status();
      return status.allowed.generate
        ? memoryMessages.off
        : memoryMessages.disabled;
    }
    return undefined;
  }

  private async execute(): Promise<RunResult> {
    const { service } = this.deps;
    await service.ready();
    const blocked = this.off();
    if (blocked) return skipped(blocked);
    const file = this.load();
    file.lastAttemptAt = this.now();
    this.controller = new AbortController();
    this.deps.service.announce();
    let pool = candidates(this.deps.conversations(), file.cursors);
    if (!pool.length) {
      this.save();
      return { status: "nothing", conversations: 0, more: false };
    }
    let read = 0;
    let more = false;
    try {
      for (const scope of scopesWithNews(pool)) {
        for (let index = 0; index < batchesPerRun; index++) {
          const batch = nextBatch(scope, pool);
          if (!batch) break;
          if (this.off()) return this.finish(skipped(this.off()!));
          await this.apply(batch);
          read += batch.chats.length;
          pool = candidates(this.deps.conversations(), file.cursors);
          if (index === batchesPerRun - 1 && batch.remaining > 0) more = true;
        }
      }
    } catch (error) {
      const message =
        error instanceof MemoryConflictError
          ? "Memory changed on another device. It will be tried again later."
          : reason(error);
      return this.finish({
        status: "failed",
        message,
        conversations: read,
        more: false,
      });
    }
    return this.finish({
      status: "done",
      conversations: read,
      more,
    });
  }

  private finish(result: RunResult): RunResult {
    const file = this.load();
    // Progress is kept only for chats that still exist.
    const existing = new Set(
      this.deps.conversations().map((conversation) => conversation.id),
    );
    for (const id of Object.keys(file.cursors))
      if (!existing.has(id)) delete file.cursors[id];
    if (result.status === "done" || result.status === "failed")
      file.lastRun = {
        at: this.now(),
        ok: result.status === "done",
        ...(result.message ? { message: result.message } : {}),
      };
    this.save();
    return result;
  }

  /** One batch into its scope's memory; a conflict is tried once more. */
  private async apply(batch: Batch) {
    const { service, complete } = this.deps;
    const file = this.load();
    for (let attempt = 0; ; attempt++) {
      const { doc, edits } = service.memoryFor(batch.scope);
      const prompt = synthesisPrompt({
        scope: batch.scope === "global" ? "global" : "project",
        existing: doc?.content ?? "",
        requests: edits.map((edit) => edit.text ?? ""),
        chats: batch.digests,
      });
      const answer = readMemoryAnswer(
        await complete(prompt, { signal: this.controller?.signal }),
      );
      if (answer.kind === "invalid") throw new Error(answer.reason);
      if (answer.kind === "memory") {
        try {
          // The edits stay: like the live claude.ai memory controls, they are
          // standing requests the person removes in Manage memory, given to
          // every summary and every chat.
          await service.saveGenerated(
            batch.scope,
            answer.content,
            doc?.revision ?? 0,
          );
        } catch (error) {
          // Another device (or window) wrote first: read again and redo once.
          if (error instanceof MemoryConflictError && attempt === 0) continue;
          throw error;
        }
      }
      for (const { conversation } of batch.chats)
        file.cursors[conversation.id] = conversation.updatedAt;
      this.save();
      return;
    }
  }

  /**
   * Merges memory exported from another assistant into the global memory,
   * without saving. Text the memory already holds is not added again.
   */
  async previewImport(
    text: string,
  ): Promise<{ merged: string; revision: number }> {
    const { service, complete } = this.deps;
    await service.ready();
    const blocked = this.off();
    if (blocked) throw new Error(blocked);
    const imported = text.trim();
    if (!imported) throw new Error("There's nothing to import.");
    if (utf8Bytes(imported) > maxImportBytes)
      throw new Error("This text is too long to import.");
    const { doc } = service.memoryFor("global");
    const existing = doc?.content ?? "";
    const revision = doc?.revision ?? 0;
    if (existing.trim() && alreadyContains(existing, imported))
      return { merged: existing, revision };
    const answer = readMemoryAnswer(
      await complete(
        importPrompt({ existing, imported: redactSecrets(imported) }),
      ).catch((error) => {
        throw new Error(reason(error));
      }),
    );
    if (answer.kind === "invalid")
      throw new Error("Couldn't merge this text. Try again.");
    if (answer.kind === "unchanged") return { merged: existing, revision };
    return { merged: dedupeLines(answer.content).trim(), revision };
  }
}
