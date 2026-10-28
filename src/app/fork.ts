import { api } from "../desktop-api";
import type { AppController } from "./AppContext";

/**
 * Fork session, Fork from here and `/fork <prompt>`: a new conversation
 * continuing the open one after a turn (its last finished turn by default),
 * opened at once; with a prompt it starts by sending it (Send in a forked
 * session). The open conversation stays as it is.
 */
export async function forkConversation(
  app: AppController,
  options: { turnId?: string; prompt?: string } = {},
) {
  const { active } = app;
  if (!active) return;
  return forkConversationById(app, active.id, options);
}

/** Fork any conversation (the sidebar row's Fork), not only the open one. */
export async function forkConversationById(
  app: AppController,
  id: string,
  options: { turnId?: string; prompt?: string } = {},
) {
  if (app.sending) return;
  app.setSending(true);
  app.setError("");
  app.notify(
    options.prompt?.trim()
      ? "Forking session with your prompt…"
      : "Forking session…",
  );
  try {
    const forked = await api.forkConversation(id, options);
    app.upsert(forked);
    app.openConversation(forked);
    return forked;
  } catch (e) {
    app.report(e);
  } finally {
    app.setSending(false);
  }
}
