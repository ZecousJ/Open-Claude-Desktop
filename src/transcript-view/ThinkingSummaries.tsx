import { useContext, useEffect } from "react";
import type { Conversation } from "../../shared/types";
import {
  onDemandThinking,
  thinkingSummariesNotice,
} from "../../shared/thinking-summaries";
import { showsThinking } from "../../shared/transcript-view";
import { AppContext } from "../app/AppContext";
import { api } from "../desktop-api";
import { useTranscriptViewContext } from "./transcript-view-store";
import "../transcript/thinking-summaries.css";

export default function ThinkingSummaries({
  conversation,
}: {
  conversation: Conversation;
}) {
  const app = useContext(AppContext);
  const wanted = showsThinking(useTranscriptViewContext());
  const onDemand = Boolean(
    app && onDemandThinking(conversation, app.snapshot.settings),
  );
  useEffect(() => {
    if (!app || !onDemand || conversation.thinkingSummariesWanted === wanted)
      return;
    let mounted = true;
    void api
      .updateConversation(conversation.id, { thinkingSummariesWanted: wanted })
      .then((saved) => {
        if (mounted) app.upsert(saved);
      })
      .catch(app.report);
    return () => {
      mounted = false;
    };
  }, [conversation.id, conversation.thinkingSummariesWanted, wanted, onDemand]);
  return app &&
    thinkingSummariesNotice(conversation, app.snapshot.settings, wanted) ? (
    <div className="thinking-summaries-notice">
      Thinking summaries will appear from the next response.
    </div>
  ) : null;
}
