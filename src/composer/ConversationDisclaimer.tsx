import { externalUrl, useOpenLink } from "../ui/ExternalLinks";
import { Suspense, useEffect, useState, type Ref } from "react";
import type { Conversation } from "../../shared/types";
import type { ReportingStatus } from "../../shared/diagnostics-api";
import { lazyPiece } from "../ui/lazy-piece";
import { feedbackDialogWanted } from "../reply-feedback/feedback-wanted";
import { t } from "../i18n";
import { helpUrl } from "../../shared/help-links";
import { useHost } from "../host/HostContext";

const ConversationFeedback = lazyPiece(
  () => import("./ConversationFeedback"),
  "ConversationFeedback",
);

export function disclaimerFeedbackAvailable(
  conversation: Conversation | undefined,
  status: ReportingStatus | null,
) {
  return conversation?.mode === "cowork" && feedbackDialogWanted(status);
}

/**
 * Conversation help note. Web uses configured help or Claudex's public support
 * route; native clients keep policy-aware link handling. The captured ordinary
 * web reply shows the first sentence. An explicit citation reminder and native
 * second-sentence behavior remain available. Phone web places this same note
 * above the input through composer CSS.
 */
export function ConversationDisclaimer({
  help,
  short,
  unified = false,
  second = "Please double-check responses.",
  conversation,
  noteRef,
  hidden = false,
  shift = 0,
}: {
  help?: string;
  short?: boolean;
  /** Main unified Chat; independent legacy clients retain their copy. */
  unified?: boolean;
  second?: string;
  conversation?: Conversation;
  /** The chin's copy, measured to decide where the note goes. */
  noteRef?: Ref<HTMLSpanElement>;
  /** Kept in the chin, unseen, while the note shows above the frame. */
  hidden?: boolean;
  /** Moves the note off the chin's centre so it clears the controls. */
  shift?: number;
}) {
  const openLink = useOpenLink();
  const web = useHost().kind === "web";
  const [status, setStatus] = useState<ReportingStatus | null>(null);
  const [feedback, setFeedback] = useState(false);
  const turn =
    conversation &&
    [...conversation.turns]
      .reverse()
      .find((item) => item.status === "completed");
  useEffect(() => {
    if (conversation?.mode !== "cowork") return;
    let live = true;
    const load = () =>
      void window.desktop
        .reportingStatus()
        .then((value) => {
          if (live) setStatus(value);
        })
        .catch(() => {});
    load();
    const off = window.desktop.onEvent((event) => {
      if (event.type === "service-changed") load();
    });
    return () => {
      live = false;
      off();
    };
  }, [conversation?.id, conversation?.mode]);
  const configured = externalUrl(help);
  const url =
    configured ??
    helpUrl("support", web ? globalThis.location?.origin : undefined);
  // The current unified Chat on web and desktop uses the first sentence.
  // Explicit source reminders and independent legacy clients remain intact.
  const showSecond =
    !short &&
    ((!web && !unified) || second === "Please double-check cited sources.");
  const text = (
    <>
      <span>Claudex is AI and can make mistakes.</span>
      {showSecond && (
        <span
          className={
            second === "Please double-check cited sources."
              ? undefined
              : "disclaimer-more"
          }
        >
          {" "}
          {second}
        </span>
      )}
    </>
  );
  return (
    <span
      ref={noteRef}
      className="conversation-disclaimer"
      role={hidden ? undefined : "note"}
      data-disclaimer="true"
      data-hidden={hidden || undefined}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      style={shift ? { translate: `${shift}px 0` } : undefined}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          // Same-origin public help needs no external-link confirmation in
          // the web app. Native clients and configured external help keep
          // the existing policy-aware opening path.
          if (web && !configured) return;
          event.preventDefault();
          openLink(url);
        }}
      >
        {text}
      </a>
      {!short && turn && disclaimerFeedbackAvailable(conversation, status) && (
        <>
          {" "}
          <button
            className="disclaimer-feedback"
            onClick={() => setFeedback(true)}
          >
            {t("Give us feedback")}
          </button>
        </>
      )}
      {feedback && turn && conversation && (
        <Suspense fallback={null}>
          <ConversationFeedback
            conversationId={conversation.id}
            turnId={turn.id}
            allowConversationExcerpt={status?.allowConversationExcerpt ?? false}
            onClose={() => setFeedback(false)}
          />
        </Suspense>
      )}
    </span>
  );
}
