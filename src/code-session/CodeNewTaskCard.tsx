import { useContext, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import { api } from "../desktop-api";
import { useT } from "../i18n";
import { Button } from "../settings/controls";
import { Dropdown } from "../settings/Dropdown";
import "./code-new-task.css";

/** Linked-session offer. */
export default function CodeNewTaskCard({
  conversation,
  onStarted,
  onError,
}: {
  conversation: Conversation;
  onStarted: (conversation: Conversation) => void;
  onError: (error: unknown) => void;
}) {
  const app = useContext(AppContext);
  const t = useT();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const offer = conversation.codeNewTask;
  if (!offer) return null;
  const choose = async (choice: "here" | "new_session", remember = false) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const started = await api.resolveCodeNewTask(
        conversation.id,
        offer.id,
        choice,
        remember,
      );
      app?.upsert(started);
      onStarted(started);
    } catch (error) {
      onError(error);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="code-new-task"
      aria-label={t("New session")}
      aria-busy={busy}
    >
      <div className="code-new-task-header">
        {t("Start this in its own session?")}
      </div>
      <div className="code-new-task-body">
        <span className="code-new-task-prompt" data-no-translate>
          {offer.text}
        </span>
        <div className="code-new-task-actions">
          <Dropdown
            label="Don’t ask again"
            placeholder="Don’t ask again"
            value={undefined}
            disabled={busy}
            options={[
              { value: "new_session", label: "Always start a new session" },
              { value: "here", label: "Always do it here" },
            ]}
            onChange={(value) =>
              void choose(value as "here" | "new_session", true)
            }
          />
          <Button disabled={busy} onClick={() => void choose("here")}>
            {t("Do it here")}
          </Button>
          <Button
            primary
            disabled={busy}
            onClick={() => void choose("new_session")}
          >
            {t(busy ? "Starting…" : "New session")}
          </Button>
        </div>
      </div>
    </section>
  );
}
