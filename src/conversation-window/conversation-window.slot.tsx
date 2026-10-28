/**
 * Package R2-C's slot module (loaded by src/main.tsx before the first
 * render): the separate conversation window's title bar, and the main
 * window's pickup of a draft a separate window hands back.
 */
import { useEffect, useRef, useState } from "react";
import { registerOverlay } from "../app/AppOverlays";
import { registerConversationWindowHeader } from "../app/AppPages";
import { useApp } from "../app/AppContext";
import { ConversationWindowHeader } from "./ConversationWindowHeader";
import "./conversation-window.css";
import { paneHandoffKey, takePaneHandoff } from "../app/pane-handoff";

registerConversationWindowHeader(ConversationWindowHeader);
registerOverlay("conversation-window-return", ReturnedDraft);
registerOverlay("tool-pane-window", ToolPaneWindow);

function ToolPaneWindow() {
  const app = useApp();
  const pane =
    app.windowRole.kind === "conversation" ? app.windowRole.pane : undefined;
  const initialized = useRef(false);
  useEffect(() => {
    if (!pane || !app.active || initialized.current) return;
    initialized.current = true;
    const target = takePaneHandoff(
      localStorage,
      paneHandoffKey(app.accountId, app.active.id, pane),
    );
    if (target) {
      app.toolPanels.setSessionId(target.sessionId);
      app.toolPanels.setWidgetId(target.widgetId);
      app.toolPanels.setAgent(target.agent);
      if (target.artifact) app.setArtifact(target.artifact);
    }
    app.setPanel(pane);
  }, [pane, app.active]);
  useEffect(() => {
    if (!pane || !app.active) return;
    const key = paneHandoffKey(app.accountId, app.active.id, pane);
    const apply = () => {
      const target = takePaneHandoff(localStorage, key);
      if (!target) return;
      app.toolPanels.setSessionId(target.sessionId);
      app.toolPanels.setWidgetId(target.widgetId);
      app.toolPanels.setAgent(target.agent);
      if (target.artifact) app.setArtifact(target.artifact);
      app.setPanel(pane);
    };
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, [pane, app.active, app.accountId]);
  useEffect(() => {
    if (!pane) return;
    document.documentElement.dataset.toolPaneWindow = pane;
    return () => {
      delete document.documentElement.dataset.toolPaneWindow;
    };
  }, [pane]);
  return null;
}

/**
 * Return to the main window closes the separate window and has the main
 * window open the conversation (an "open-conversation" command); opening it
 * clears the composer, so the draft the window handed back is taken once the
 * conversation is on screen. Renders nothing.
 */
function ReturnedDraft() {
  const app = useApp();
  // A new object each time, so the same conversation returning twice counts.
  const [pending, setPending] = useState<{ id: string }>();
  const main = app.windowRole.kind === "main";
  useEffect(() => {
    const api = window.desktop;
    if (!main || !api?.takeWindowHandoff) return;
    return api.onEvent((event) => {
      if (
        event.type === "command" &&
        event.command === "open-conversation" &&
        event.conversationId
      )
        setPending({ id: event.conversationId });
    });
  }, [main]);
  const { activeId, setText, setAttachments, setProviderId, setModel, report } =
    app;
  const shown = useRef(activeId);
  shown.current = activeId;
  useEffect(() => {
    if (!pending || pending.id !== activeId) return;
    const id = pending.id;
    setPending(undefined);
    void window.desktop
      .takeWindowHandoff()
      .then((handoff) => {
        // The person may have moved on while the draft was on its way.
        if (!handoff || shown.current !== id) return;
        setText(handoff.text);
        if (handoff.attachments) setAttachments(handoff.attachments);
        if (handoff.providerId) setProviderId(handoff.providerId);
        if (handoff.model) setModel(handoff.model);
      })
      .catch(report);
  }, [pending, activeId]);
  return null;
}
