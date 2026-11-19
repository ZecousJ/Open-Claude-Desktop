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
import type { Melange } from "./melange";
import {
  alreadyContains,
  dedupeLines,
  importPrompt,
  readMemoryAnswer,
  synthesisPrompt,
} from "./prompts";
import { MemoryConflictError, MemoryControlsConflictError } from "./store";
import type { MemoryRunState, MemoryService } from "./service";
import {
  maxImportBytes,
  memoryMessages,
  utf8Bytes,
  type MemoryScope,
} from "./types";

export const memoryCursorFile = "memory-cursor.json";

/** Most batches one run reads for a scope; the rest wait for the next run. */
export const batchesPerRun = 3;

const cursorSchema = z.object({
  version: z.literal(1),
  cursors: z.record(z.string().max(200), z.number().nonnegative()),
  melangeCursors: z.record(z.string().max(200), z.number().nonnegative()).optional(),
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
  melange?(): Promise<Melange | undefined>;
  ownsScope?(scope: MemoryScope): boolean;
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

const regenerationCancelled = "Memory regeneration was cancelled.";

function waitForRun(result: Promise<RunResult>, signal?: AbortSignal) {
  if (!signal) return result;
  if (signal.aborted) return Promise.resolve(skipped(regenerationCancelled));
  let abort: (() => void) | undefined;
  const cancelled = new Promise<RunResult>((resolve) => {
    abort = () => resolve(skipped(regenerationCancelled));
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([result, cancelled]).finally(() => {
    if (abort) signal.removeEventListener("abort", abort);
  });
}

/** A model or network failure as a sentence for the person. */
function reason(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown error.";
}

export class MemorySynthesizer {
  private file: CursorFile | undefined;
  private active?: {
    scope?: MemoryScope;
    classic: boolean;
    result: Promise<RunResult>;
    controller: AbortController;
  };
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
      synthesizing: !!this.active,
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

  /** Runs incremental synthesis after any active regeneration. */
  run(): Promise<RunResult> {
    if (this.stopped) return Promise.resolve(skipped("Memory is stopped."));
    const active = this.active;
    if (!active) return this.start((signal) => this.execute(signal));
    return active.scope === undefined
      ? active.result
      : active.result.then(() => this.run());
  }

  /** Explicit regeneration reads all eligible history for this scope. The
   * existing document survives until every model batch has succeeded. */
  async regenerate(
    scope: MemoryScope,
    signal?: AbortSignal,
    checkCurrent?: () => void,
  ): Promise<RunResult> {
    if (signal?.aborted) return skipped(regenerationCancelled);
    while (this.active) {
      const active = this.active;
      if (active.scope === scope) return waitForRun(active.result, signal);
      await waitForRun(active.result, signal);
      if (signal?.aborted) return skipped(regenerationCancelled);
    }
    if (this.stopped) return skipped("Memory is stopped.");
    return this.start(
      (runSignal) => this.regenerateScope(scope, runSignal, checkCurrent),
      scope,
      signal,
    );
  }

  private start(
    run: (signal: AbortSignal) => Promise<RunResult>,
    scope?: MemoryScope,
    ownerSignal?: AbortSignal,
  ): Promise<RunResult> {
    const controller = new AbortController();
    const signal = ownerSignal
      ? AbortSignal.any([controller.signal, ownerSignal])
      : controller.signal;
    const result = run(signal).finally(() => {
      this.active = undefined;
      this.deps.service.announce();
    });
    this.active = { scope, classic: scope !== undefined, controller, result };
    return result;
  }

  private async regenerateScope(
    scope: MemoryScope,
    signal: AbortSignal,
    checkCurrent?: () => void,
  ): Promise<RunResult> {
    const { service, complete } = this.deps;
    const check = () => {
      if (signal.aborted) throw new Error(regenerationCancelled);
      checkCurrent?.();
    };
    const checkGeneration = () => {
      check();
      const blocked = this.off();
      if (blocked) throw new Error(blocked);
    };
    let read = 0;
    try {
      await service.ready();
      check();
      await service.refresh();
      check();
      const blocked = this.off();
      if (blocked) return skipped(blocked);
      service.announce();
      const { doc, edits } = service.memoryFor(scope);
      const baseVersion = service.controlsVersion(scope);
      if (!baseVersion)
        throw new Error(
          "This server does not support safe memory regeneration yet.",
        );
      let content = redactSecrets(doc?.content ?? "");
      let pool = candidates(this.deps.conversations(), {}).filter(
        (entry) => entry.scope === scope,
      );
      const requests = edits.map((edit) => redactSecrets(edit.text ?? ""));
      const consumed: { id: string; updatedAt: number }[] = [];
      do {
        const batch = nextBatch(scope, pool);
        const answer = readMemoryAnswer(
          await complete(
            synthesisPrompt({
              scope: scope === "global" ? "global" : "project",
              existing: content,
              requests,
              chats: batch?.digests ?? [],
            }),
            { signal, checkBeforeSend: checkGeneration },
          ),
        );
        checkGeneration();
        if (answer.kind === "invalid") throw new Error(answer.reason);
        if (answer.kind === "memory") content = answer.content;
        if (!batch) break;
        const ids = new Set(
          batch.chats.map(({ conversation }) => conversation.id),
        );
        consumed.push(
          ...batch.chats.map(({ conversation }) => ({
            id: conversation.id,
            updatedAt: conversation.updatedAt,
          })),
        );
        read += batch.chats.length;
        pool = pool.filter(({ conversation }) => !ids.has(conversation.id));
      } while (pool.length);
      await service.saveGenerated(
        scope,
        content,
        doc?.revision ?? 0,
        undefined,
        baseVersion,
        checkGeneration,
      );
      if (!this.stopped)
        for (const chat of consumed)
          this.load().cursors[chat.id] = chat.updatedAt;
      return this.finish({ status: "done", conversations: read, more: false });
    } catch (error) {
      const result: RunResult = {
        status: "failed",
        message: signal.aborted ? regenerationCancelled : reason(error),
        conversations: read,
        more: false,
      };
      return signal.aborted ? result : this.finish(result);
    }
  }

  cancelClassic() {
    if (this.active?.classic) this.active.controller.abort();
  }

  /** Cancels a running summary and stops taking new ones (sign-out). */
  stop() {
    this.stopped = true;
    this.active?.controller.abort();
    this.deps.service.setRunState(undefined);
  }

  private off(): string | undefined {
    const { service } = this.deps;
    if (!service.canRegenerate()) {
      const status: MemoryStatus = service.status();
      if (status.reason === "offline") return memoryMessages.offline;
      return status.allowed.generate
        ? memoryMessages.off
        : memoryMessages.disabled;
    }
    return undefined;
  }

  private async execute(signal: AbortSignal): Promise<RunResult> {
    const { service } = this.deps;
    await service.ready();
    if (signal.aborted) return skipped("Memory is stopped.");
    if (service.store.kind === "remote") await service.refresh();
    if (signal.aborted) return skipped("Memory is stopped.");
    const blocked = this.off();
    if (!this.deps.melange && blocked) return skipped(blocked);
    const file = this.load();
    let read = 0;
    let more = false;
    try {
      const conversations = this.deps.conversations;
      const poolFor = (cursor: MemoryCursor) => candidates(conversations(), cursor);
      const melangePool = (cursor: MemoryCursor) => poolFor(cursor).filter(({ scope }) => this.deps.ownsScope?.(scope) !== false);
      let melange: Melange | undefined;
      let cursor = file.cursors;
      if (this.deps.melange && melangePool({}).length) {
        const service = await this.deps.melange();
        const state = await service?.read("classic");
        if (signal.aborted) return skipped("Memory is stopped.");
        if (state?.mode === "off") return skipped(memoryMessages.off);
        if (state?.mode === "melange") {
          if (state.switchImport?.status === "pending") {
            await service?.importStatus("switchImport");
            return { status: "nothing", conversations: 0, more: true };
          }
          melange = service;
          cursor = file.melangeCursors ??= state.switchImport?.status === "ok" ? { ...file.cursors } : {};
        }
      }
      if (!melange && blocked) return skipped(blocked);
      if (this.active) this.active.classic = !melange;
      file.lastAttemptAt = this.now();
      this.deps.service.announce();
      const pool = () => melange ? melangePool(cursor) : poolFor(cursor);
      let pending = pool();
      if (!pending.length) return this.finish({ status: "nothing", conversations: 0, more: false });
      for (const scope of scopesWithNews(pending)) {
        for (let index = 0; index < batchesPerRun; index++) {
          const batch = nextBatch(scope, pending);
          if (!batch) break;
          const consumed = batch.chats.map(({ conversation }) => ({ id: conversation.id, updatedAt: conversation.updatedAt }));
          if (melange) {
            const result = await melange.synthesize({ scope, digests: batch.digests, signal });
            if (result.rejected) throw Error(memoryMessages.sensitive);
          } else {
            const blocked = this.off();
            if (blocked) return this.finish(skipped(blocked));
            await this.apply(batch, signal);
          }
          if (signal.aborted) return skipped("Memory is stopped.");
          for (const chat of consumed) cursor[chat.id] = chat.updatedAt;
          this.save();
          read += batch.chats.length;
          pending = pool();
          if (index === batchesPerRun - 1 && batch.remaining > 0) more = true;
        }
      }
    } catch (error) {
      if (signal.aborted) return skipped("Memory synthesis was cancelled.");
      file.lastAttemptAt = this.now();
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
    if (this.stopped) return result;
    const file = this.load();
    // Progress is kept only for chats that still exist.
    const existing = new Set(
      this.deps.conversations().map((conversation) => conversation.id),
    );
    for (const id of Object.keys(file.cursors))
      if (!existing.has(id)) delete file.cursors[id];
    for (const id of Object.keys(file.melangeCursors ?? {}))
      if (!existing.has(id)) delete file.melangeCursors?.[id];
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
  private async apply(batch: Batch, signal: AbortSignal) {
    const { service, complete } = this.deps;
    const checkGeneration = () => {
      if (signal.aborted) throw new Error("Memory synthesis was cancelled.");
      const blocked = this.off();
      if (blocked) throw new Error(blocked);
    };
    for (let attempt = 0; ; attempt++) {
      checkGeneration();
      const { doc, edits } = service.memoryFor(batch.scope);
      const controlsVersion = service.controlsVersion(batch.scope);
      const prompt = synthesisPrompt({
        scope: batch.scope === "global" ? "global" : "project",
        existing: redactSecrets(doc?.content ?? ""),
        requests: edits.map((edit) => redactSecrets(edit.text ?? "")),
        chats: batch.digests,
      });
      const answer = readMemoryAnswer(
        await complete(prompt, { signal, checkBeforeSend: checkGeneration }),
      );
      if (answer.kind === "invalid") throw new Error(answer.reason);
      checkGeneration();
      if (answer.kind === "memory") {
        try {
          // The edits stay: like the live claude.ai memory controls
          // (2026-10-12), they are standing requests the person removes in
          // Manage memory, given to every summary and every chat.
          await service.saveGenerated(
            batch.scope,
            answer.content,
            doc?.revision ?? 0,
            undefined,
            controlsVersion,
            checkGeneration,
          );
        } catch (error) {
          // Another device (or window) wrote first: read again and redo once.
          if (
            (error instanceof MemoryConflictError ||
              (error instanceof MemoryControlsConflictError && !error.reset)) &&
            attempt === 0
          )
            continue;
          throw error;
        }
      }
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
