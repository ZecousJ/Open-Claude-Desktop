import { api } from "../desktop-api";
import type { AppController } from "./AppContext";

/**
 * Hand off to a new session (the context ring's button, `/handoff`, and the
 * notice under a reply that ran out of room): a new Code session that starts
 * from a note about the open one, opened at once. The note takes a moment to
 * write, so the composer stays busy until the new session is there. The open
 * session stays as it is.
 */
export async function handOffConversation(app: AppController) {
  const { active } = app;
  if (!active || app.sending || app.running) return;
  app.setSending(true);
  app.setError("");
  app.notify("Writing the handoff note");
  try {
    const handed = await api.handOffConversation(active.id);
    app.upsert(handed);
    app.openConversation(handed);
    return handed;
  } catch (e) {
    app.report(e);
  } finally {
    app.setSending(false);
  }
}
