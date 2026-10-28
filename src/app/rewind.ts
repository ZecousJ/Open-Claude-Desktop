import { api } from "../desktop-api";
import type { AppController } from "./AppContext";
import { forkConversation } from "./fork";
import { askRewind } from "./rewind-ask";
import type { RewindScope } from "../../shared/rewind-files";
import { formatText } from "../i18n";

/**
 * Rewind to here / `/rewind`: removes a message and what follows (the last
 * message when none is named) and puts that message back in the composer.
 * Refused while Claude works or while the composer holds a draft ("Send or
 * clear your draft first").
 */
export async function rewindConversation(app: AppController, turnId?: string) {
  const { active } = app;
  if (!active || app.sending) return;
  if (app.running) {
    app.notify("Rewind is unavailable while Claudex is working");
    return;
  }
  const turn = turnId
    ? active.turns.find((t) => t.id === turnId)
    : active.turns.at(-1);
  if (!turn) {
    app.notify("Nothing to rewind to yet");
    return;
  }
  if (app.text.trim() || app.attachments.length) {
    app.notify("Send or clear your draft first, then select Rewind and retry.");
    return;
  }
  // "Rewind to this message?" asks first (RewindDialog), then rewinds.
  askRewind({ conversationId: active.id, turnId: turn.id, text: turn.prompt });
}

/**
 * The confirmed rewind: the code first when asked (the file edits Claude made
 * from the message on, undone on this computer), then the conversation.
 */
export async function confirmRewind(
  app: AppController,
  turnId: string,
  scope: RewindScope,
) {
  const { active } = app;
  if (!active) return;
  const turn = active.turns.find((t) => t.id === turnId);
  if (!turn) return;
  if (scope !== "conversation") {
    try {
      const result = await api.restoreRewindCode(active.id, turn.id);
      if (result.skipped > 0)
        app.notify(
          formatText(
            result.skipped === 1
              ? "Restored the code, but skipped 1 file that couldn’t be safely written. Skipped files were left untouched."
              : "Restored the code, but skipped {count} files that couldn’t be safely written. Skipped files were left untouched.",
            { count: result.skipped },
          ),
        );
      else if (scope === "code") app.notify("Code restored");
    } catch {
      app.notify("Couldn’t restore the code from this point. Try again.");
      return;
    }
  }
  if (scope === "code") return;
  app.setSending(true);
  app.setError("");
  try {
    app.upsert(await api.rewindConversation(active.id, turn.id));
    app.setText(turn.prompt);
    if (turn.attachments?.length) app.setAttachments(turn.attachments);
    requestAnimationFrame(() => app.composer.current?.focus());
  } catch (e) {
    app.report(e);
  } finally {
    app.setSending(false);
  }
}

/** Undo rewind / Redo rewind. */
export async function swapRewind(app: AppController) {
  const { active } = app;
  if (!active || app.sending || app.running) return;
  try {
    app.upsert(await api.swapRewind(active.id));
  } catch (e) {
    app.report(e);
  }
}

/**
 * Fork from here on a message: a new session holding what came before it,
 * with the message waiting in its composer ("Starts a new session, keeps
 * this one").
 */
export async function forkBeforeMessage(app: AppController, turnId: string) {
  const { active } = app;
  if (!active) return;
  const index = active.turns.findIndex((t) => t.id === turnId);
  if (index <= 0) return;
  const turn = active.turns[index];
  const forked = await forkConversation(app, {
    turnId: active.turns[index - 1].id,
  });
  if (!forked) return;
  app.setText(turn.prompt);
  if (turn.attachments?.length) app.setAttachments(turn.attachments);
}
