import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FinishedBackgroundTerminal } from "../../shared/panels-api";

/** Ended background terminals kept per profile. */
const maxFinished = 200;
const text = (max: number) => z.string().max(max);
const finishedSchema = z
  .object({
    id: text(1100).min(1),
    conversationId: text(500).min(1),
    itemId: text(500),
    processId: text(500).min(1),
    command: text(20_000),
    cwd: text(4096),
    status: z.enum(["stopped", "completed"]),
    finishedAt: z.number().int().nonnegative(),
  })
  .strict();
const schema = z.union([
  z
    .object({
      version: z.literal(1),
      dismissed: z.array(z.string().min(1).max(1000)).max(1000),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      dismissed: z.array(z.string().min(1).max(1000)).max(1000),
      finished: z.array(finishedSchema).max(maxFinished),
    })
    .strict(),
]);
/** The id a finished background terminal has in the Background tasks panel. */
export function finishedTerminalId(conversationId: string, processId: string) {
  return `terminal:${conversationId}:${processId}`;
}

/**
 * Display-only task history, isolated in the active account profile: which
 * finished tasks the user cleared from the Background tasks panel, and the
 * background terminals that ended (stopped from the panel, or gone from Codex's
 * list on their own), so the panel can keep them under Finished. Nothing here
 * is sent anywhere.
 */
export class BackgroundHistory {
  private filename: string;
  private dismissed: string[];
  private ended: FinishedBackgroundTerminal[];
  constructor(root: string) {
    this.filename = path.join(root, "background-history.json");
    try {
      const parsed = schema.parse(
        JSON.parse(fs.readFileSync(this.filename, "utf8")),
      );
      this.dismissed = parsed.dismissed;
      this.ended = parsed.version === 2 ? parsed.finished : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error(
          "Background task history cannot be read; it has not been overwritten.",
        );
      this.dismissed = [];
      this.ended = [];
    }
  }
  list() {
    return [...this.dismissed];
  }
  clear(ids: string[]) {
    const next = [...new Set([...this.dismissed, ...ids])].slice(-1000);
    if (
      next.length === this.dismissed.length &&
      next.every((value, index) => value === this.dismissed[index])
    )
      return this.list();
    this.write(next, this.ended);
    return this.list();
  }
  /** Background terminals of this conversation that ended, oldest first. */
  finished(conversationId: string) {
    return this.ended
      .filter((item) => item.conversationId === conversationId)
      .map((item) => ({ ...item }));
  }
  /**
   * Keeps an ended background terminal. The first record wins, so a
   * terminal stopped from the panel stays "stopped" when it then drops out
   * of Codex's list.
   */
  recordFinished(item: Omit<FinishedBackgroundTerminal, "id">) {
    const id = finishedTerminalId(item.conversationId, item.processId);
    if (this.ended.some((value) => value.id === id)) return;
    const next = [...this.ended, finishedSchema.parse({ ...item, id })].slice(
      -maxFinished,
    );
    this.write(this.dismissed, next);
  }
  private write(dismissed: string[], finished: FinishedBackgroundTerminal[]) {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ version: 2, dismissed, finished }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.filename);
    this.dismissed = dismissed;
    this.ended = finished;
  }
}
