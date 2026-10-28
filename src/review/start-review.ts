import { api } from "../desktop-api";
import type { AppController } from "../app/AppContext";
import { parseReviewArguments } from "./review-target";

/**
 * /review: Codex reviews the open session's changes (`review/start`). The
 * text after the command picks the target (review-target.ts); the turn shows
 * the line as typed and ends with the review's findings. It loads when the
 * command first runs.
 */
export async function startSessionReview(app: AppController, args: string) {
  const { active } = app;
  if (!active) return;
  if (app.running || app.sending) {
    app.notify("Wait for Claudex to finish before reviewing.");
    return;
  }
  const target = parseReviewArguments(args);
  if ("error" in target) {
    app.notify(target.error);
    return;
  }
  app.setSending(true);
  try {
    app.follow.current = true;
    const line = args.trim() ? `/review ${args.trim()}` : "/review";
    app.upsert(await api.startReview(active.id, target, line));
  } catch (e) {
    app.report(e);
  } finally {
    app.setSending(false);
  }
}
