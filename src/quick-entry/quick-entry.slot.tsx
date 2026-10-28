/**
 * Quick Entry's hand-over (shared/quick-entry.ts; loaded by src/main.tsx
 * before the first render): the main window, brought forward by the main
 * process, starts a new chat and sends the prompt typed into the Quick
 * Entry composer.
 */
import { useEffect, useRef, useState } from "react";
import { registerOverlay } from "../app/AppOverlays";
import { useApp } from "../app/AppContext";
import { sendText } from "../app/composer-send";
import type { Attachment } from "../../shared/types";

registerOverlay("quick-entry", QuickEntryPrompt);

/**
 * Starts the new chat when the prompt arrives, then sends it once the new
 * chat's draft is on screen (a new draft session), so it goes to the new
 * chat and not to whatever was open. Renders nothing.
 */
function QuickEntryPrompt() {
  const app = useApp();
  const latest = useRef(app);
  latest.current = app;
  const [pending, setPending] = useState<{
    text: string;
    attachments?: Attachment[];
    session: string;
  }>();
  const main = app.windowRole.kind === "main";
  useEffect(() => {
    const api = window.desktop;
    if (!main || !api?.onEvent) return;
    return api.onEvent((event) => {
      if (
        event.type !== "quick-entry" ||
        (!event.text && !event.attachments?.length)
      )
        return;
      setPending({
        text: event.text,
        attachments: event.attachments,
        session: latest.current.draftSession,
      });
      latest.current.newChat("chat");
    });
  }, [main]);
  useEffect(() => {
    if (!pending || app.draftSession === pending.session) return;
    if (app.activeId || app.page !== "chat" || app.mode !== "chat") return;
    setPending(undefined);
    void sendText(app, pending.text, pending.attachments).catch(app.report);
  }, [pending, app.draftSession, app.activeId, app.page, app.mode]);
  return null;
}
