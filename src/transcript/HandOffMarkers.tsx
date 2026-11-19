import type { Conversation } from "../../shared/types";
import { formatText, t } from "../i18n";
import { Anthropicon } from "../ui/anthropicons";

/*
 * Where a handed-off session came from, and where it was handed off to.
 * The live claude.ai bundle (2026-10-13) words a session Claude started
 * (lineage kind hand_off or side_session) "Started by Claudex from {title}"
 * (shared-21, key +zUGSq16ni), and, on the parent's side, maps hand-offs
 * and forks alike to "Forked here: {title}" (c1c1ec7b9, VoRenoPbbh); it has
 * no "Handed off" wording. The markers share the fork markers' frame
 * (src/ForkMarkers.tsx).
 */

type Lookup = (id: string) => Conversation | undefined;

/** "Started by Claudex from {title}" above a handed-off session's first turn. */
export function HandedOffFrom({
  conversation,
  lookup,
  onOpen,
}: {
  conversation: Conversation;
  lookup: Lookup;
  onOpen: (conversation: Conversation) => void;
}) {
  const source = conversation.handedOffFrom;
  if (!source) return null;
  const parent = lookup(source.conversationId);
  const title = parent?.title ?? source.title;
  const body = (
    <>
      <Anthropicon name="ArrowSplitRight" />
      <span>
        {title
          ? formatText("Started by Claudex from {title}", { title })
          : t("Started by Claudex from another session")}
      </span>
    </>
  );
  return (
    <div className="fork-marker fork-source" data-testid="hand-off-source">
      {parent ? (
        <button
          type="button"
          aria-label={formatText("Go to parent session {title}", { title })}
          onClick={() => onOpen(parent)}
        >
          {body}
        </button>
      ) : (
        <span>{body}</span>
      )}
    </div>
  );
}

/** The sessions this one was handed off to, under the turn it was handed off after. */
export function HandedOffHere({
  conversation,
  turnId,
  lookup,
  onOpen,
}: {
  conversation: Conversation;
  turnId: string;
  lookup: Lookup;
  onOpen: (conversation: Conversation) => void;
}) {
  const sessions = (conversation.handOffs ?? [])
    .filter((record) => record.turnId === turnId)
    .map((record) => lookup(record.conversationId))
    .filter((session): session is Conversation => Boolean(session));
  return (
    <>
      {sessions.map((session) => {
        const body = (
          <>
            <Anthropicon name="ArrowSplitRight" />
            <span>
              {formatText("Forked here: {title}", {
                title: session.title || "Untitled session",
              })}
            </span>
            {session.archived && (
              <span className="fork-archived">
                · <span>Archived</span>
              </span>
            )}
          </>
        );
        return (
          <div
            key={session.id}
            className="fork-marker"
            data-testid="hand-off-marker"
          >
            {session.archived ? (
              <span>{body}</span>
            ) : (
              <button type="button" onClick={() => onOpen(session)}>
                {body}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
