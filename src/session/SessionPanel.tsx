import type { Conversation } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { SessionPaneFrame } from "../app/SessionPaneFrame";
import { MiniSessionView } from "../cowork/MiniSessionView";
import "../cowork/spin-off-windows.css";
import { t } from "../i18n";

export function SessionPanel({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const app = useApp();
  const sessionId = app.toolPanels.sessionId ?? conversation.id;
  return (
    <SessionPaneFrame pane="session" title="Session" onClose={onClose}>
      <div className="session-pane-body">
        <select
          aria-label={t("Session")}
          value={sessionId}
          onChange={(event) => app.toolPanels.setSessionId(event.target.value)}
        >
          {app.snapshot.conversations.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title}
            </option>
          ))}
        </select>
        <MiniSessionView key={sessionId} sessionId={sessionId} shown />
      </div>
    </SessionPaneFrame>
  );
}
