import { useEffect, useState } from "react";
import { RotateCcw } from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import { formatText, t } from "../../i18n";
import { api } from "../../desktop-api";
import type {
  HostedShare,
  SharedChatContent,
} from "../../../shared/sharing-api";
import type { Conversation } from "../../../shared/types";
import { Markdown } from "../../ui/components";
import { AssistantMessage } from "../../transcript/AssistantMessage";
import { useApp } from "../../app/AppContext";
import { onSharedChatRequest, sharedChatRequest } from "../open-requests";
import { ReportChatDialog } from "./ReportChatDialog";
import "./shared.css";
import { SharedArtifactEditor } from "./SharedArtifactEditor";

/** Whether the signed-in account shared this chat itself. */
export function sharedByMe(
  chat: Pick<SharedChatContent, "owner"> | null | undefined,
  email: string | undefined,
) {
  return Boolean(
    chat?.owner && email && chat.owner.toLowerCase() === email.toLowerCase(),
  );
}

/** The account's own share a token belongs to (its link ends with it). */
export function shareForToken(shares: HostedShare[], token: string) {
  return shares.find((share) =>
    [share.url, share.inviteUrl].some((url) => url?.endsWith(`/${token}`)),
  );
}

/**
 * A chat someone shared with the signed-in account (/shared/<token>): the
 * prompts and replies the sharer's snapshot holds, read-only, in the
 * transcript's own message styles. Read as the address the sharer invited (the
 * service answers only for it); anyone else sees the same "isn't available" as
 * for a link that never existed. When the administrator takes reports, Report
 * opens Report chat.
 *
 * * "Ask Claudex your own question", which starts a new chat; or, for the
 *   person who shared it, "This is the read-only copy that you shared of your
 *   chat." with Open original chat when that chat is on this computer.
 */
export function SharedChatPage() {
  const app = useApp();
  const [token, setToken] = useState(sharedChatRequest);
  const [chat, setChat] = useState<SharedChatContent | null>();
  const [reporting, setReporting] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => onSharedChatRequest(setToken), []);
  useEffect(() => {
    if (!token) return;
    let live = true;
    setChat(undefined);
    setReporting(false);
    Promise.resolve()
      .then(() => api.readSharedChat(token))
      .then(
        (content) => live && setChat(content),
        () => {
          if (live) setChat(null);
        },
      );
    return () => {
      live = false;
    };
  }, [token, reload]);
  const back = () => app.newChat();
  const own = sharedByMe(chat, app.accountEmail);
  const [original, setOriginal] = useState<Conversation>();
  useEffect(() => {
    setOriginal(undefined);
    if (!own || !token) return;
    let live = true;
    Promise.resolve()
      .then(() => api.hostedShares("conversation"))
      .then(
        (shares) => {
          const key = shareForToken(shares, token)?.sourceKey;
          const found = key
            ? app.listed.find((item) => item.id === key)
            : undefined;
          if (live) setOriginal(found);
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [own, token]);
  return (
    <div className="shared-chat">
      <nav className="prj-crumbs shared-crumbs" aria-label="Breadcrumb">
        <button type="button" onClick={back}>
          New chat
        </button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Shared with you</span>
      </nav>
      {reporting && chat?.reportable && token && (
        <ReportChatDialog token={token} onClose={() => setReporting(false)} />
      )}
      {chat === undefined ? (
        <div className="shared-state" aria-label="Loading the chat">
          <Spinner inheritColor size={18} className="spin" />
        </div>
      ) : chat === null ? (
        <div className="shared-state" role="status">
          <h1>Something went wrong</h1>
          <p>This conversation couldn’t be loaded. Try again in a moment.</p>
          <button
            type="button"
            className="primary"
            onClick={() => setReload((value) => value + 1)}
          >
            <RotateCcw size={16} /> Try again
          </button>
        </div>
      ) : (
        <div className="messages-scroll shared-scroll">
          <header className="shared-head">
            <h1>{chat.title || "Untitled"}</h1>
            <div className="shared-disclaimer">
              <p>
                <strong>Shared by {chat.owner || "someone"}.</strong>{" "}
                {chat.owner
                  ? formatText(
                      "This is a copy of a chat between Claudex and {sharedBy}. Content may include unverified or unsafe content that does not represent the views of Claudex. Shared snapshot may contain attachments and data not displayed here.",
                      { sharedBy: chat.owner },
                    )
                  : t(
                      "This is a copy of a chat between Claudex and a user. Content may include unverified or unsafe content that does not represent the views of Claudex. Shared snapshot may contain attachments and data not displayed here.",
                    )}
              </p>
              {chat.reportable && token && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setReporting(true)}
                >
                  Report
                </button>
              )}
            </div>
          </header>
          <div className="messages">
            {chat.kind === "artifact" && token && (
              <SharedArtifactEditor
                token={token}
                chat={chat}
                onChanged={setChat}
                onError={(error) =>
                  app.notify(
                    error instanceof Error ? error.message : String(error),
                  )
                }
              />
            )}
            {chat.messages.map((message, index) =>
              message.role === "user" ? (
                <div className="turn" key={index}>
                  <div className="user-message">
                    <div>{message.text}</div>
                  </div>
                </div>
              ) : (
                <div className="assistant-message" key={index}>
                  <div className="assistant-content">
                    {message.activity?.length ? (
                      <p className="shared-activity">
                        {message.activity.join(", ")}
                      </p>
                    ) : null}
                    {message.text && (
                      <AssistantMessage
                        bubble={chat.sessionAuthors !== undefined}
                      >
                        <div className="markdown prose" data-cds="Prose">
                          <Markdown text={message.text} />
                        </div>
                      </AssistantMessage>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
          <div className="shared-continue">
            {own ? (
              <div className="shared-own" role="note">
                <span>
                  This is the read-only copy that you shared of your chat.
                </span>
                {original && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => app.openConversation(original)}
                  >
                    Open original chat
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => app.newChat("chat")}
              >
                Ask Claudex your own question
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
