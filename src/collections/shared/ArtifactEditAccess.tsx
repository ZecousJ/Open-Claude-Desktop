import { useEffect, useRef, useState } from "react";
import type {
  SharedChatContent,
  ArtifactEditAccessResult,
} from "../../../shared/sharing-api";
import { api } from "../../desktop-api";
import { t } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";

// .
export const editAccessMessages = {
  already_granted: "You already have edit access. Reload to start editing.",
  cooldown: "A recent request was declined. You can ask again later.",
  unavailable: "Edit access can’t be requested on this artifact.",
  failed: "Couldn’t send the request. Try again.",
};

export default function ArtifactEditAccess({
  token,
  chat,
  onChanged,
  onError,
}: {
  token: string;
  chat: SharedChatContent;
  onChanged: (chat: SharedChatContent) => void;
  onError: (error: unknown) => void;
}) {
  const [pending, setPending] = useState(chat.editRequestPending === true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = useRef(token);
  current.current = token;
  useEffect(() => {
    setPending(chat.editRequestPending === true);
    setMessage("");
    setBusy(false);
  }, [token, chat.editRequestPending]);
  async function request() {
    if (pending || busy) return;
    setBusy(true);
    let result: ArtifactEditAccessResult;
    try {
      result = await api.requestArtifactEditAccess(token);
    } catch {
      result = "failed";
    }
    if (current.current !== token) return;
    setBusy(false);
    if (result === "filed") {
      setPending(true);
      return;
    }
    if (result === "already_granted") {
      setMessage(editAccessMessages.already_granted);
      void api.readSharedChat(token).then((value) => {
        if (current.current === token) onChanged(value);
      }, onError);
    } else onError(new Error(t(editAccessMessages[result])));
  }
  return (
    <>
      {chat.canEdit === false && chat.canRequestEdit !== false && (
        <WithTooltip
          label={
            pending ? t("You’ll be able to edit if an owner approves.") : ""
          }
        >
          {(tooltip) => (
            <button
              {...tooltip}
              className="artifact-edit-access"
              aria-disabled={pending || busy || undefined}
              aria-busy={busy || undefined}
              data-edit-request={pending ? "pending" : "offered"}
              onClick={() => void request()}
            >
              {t(pending ? "Request sent" : busy ? "Sending…" : "Ask to edit")}
            </button>
          )}
        </WithTooltip>
      )}
      <span className="sr-only" aria-live="polite">
        {pending ? t("You’ll be able to edit if an owner approves.") : ""}
      </span>
      {message && <p role="status">{t(message)}</p>}
      {chat.editRequests?.map((request) => (
        <div className="publish-artifact-link" key={request.email}>
          <span>{request.email}</span>
          {[true, false].map((allow) => (
            <button
              className="secondary"
              key={String(allow)}
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  await api.respondArtifactEditAccess(
                    token,
                    request.email,
                    allow,
                  );
                  const next = await api.readSharedChat(token);
                  if (current.current === token) onChanged(next);
                } catch (error) {
                  onError(error);
                } finally {
                  if (current.current === token) setBusy(false);
                }
              }}
            >
              {t(allow ? "Allow" : "Decline")}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
