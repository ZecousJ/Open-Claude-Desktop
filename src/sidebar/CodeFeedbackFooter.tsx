import { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../../shared/types";
import type { ReportingStatus } from "../../shared/diagnostics-api";
import { IconButton } from "../ui/Controls";
import { AppIcon } from "../ui/app-icon";
import { lazyPiece } from "../ui/lazy-piece";
import { t } from "../i18n";
import { codeFeedbackEvent } from "../code-feedback/feedback-request";

const CodeFeedbackDialog = lazyPiece(
  () => import("../code-feedback/CodeFeedbackDialog"),
  "CodeFeedbackDialog",
);

/** O14/shared-22:19565 and c8e5af2c6:650: Ant at the session-aware footer. */
export function CodeFeedbackFooter({
  conversation,
  accountId,
  consent,
}: {
  conversation?: Conversation;
  accountId: string;
  consent?: boolean;
}) {
  const key = JSON.stringify([accountId, conversation?.id, consent]);
  const [status, setStatus] = useState<{
    key: string;
    value: ReportingStatus | null;
  }>();
  const [report, setReport] = useState<{
    key: string;
    accountId: string;
    conversationId: string;
    excerpt: boolean;
  }>();
  useEffect(() => setReport(undefined), [accountId]);
  useEffect(() => {
    let live = true,
      request = 0;
    if (!conversation || conversation.mode !== "code") return;
    const refresh = () => {
      if (typeof window.desktop?.reportingStatus !== "function") return;
      const token = ++request;
      void window.desktop.reportingStatus().then(
        (value) => live && token === request && setStatus({ key, value }),
        () => live && token === request && setStatus({ key, value: null }),
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [key, conversation?.mode]);
  const current = status?.key === key ? status.value : null;
  const enabled =
    !!conversation &&
    conversation.mode === "code" &&
    !!current?.codeSessionFeedback &&
    current.feedback &&
    current.consented &&
    consent !== false &&
    typeof window.desktop.submitCodeFeedback === "function";
  const start = () => {
    if (!enabled || !conversation || !current) return false;
    setReport({
      key,
      accountId,
      conversationId: conversation.id,
      excerpt: current.allowConversationExcerpt && !conversation.incognito,
    });
    return true;
  };
  // /feedback in the composer does what this button does.
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ handled: boolean }>).detail;
      if (!detail.handled) detail.handled = start();
    };
    window.addEventListener(codeFeedbackEvent, open);
    return () => window.removeEventListener(codeFeedbackEvent, open);
  });
  return (
    <>
      <IconButton
        label={t("Send feedback")}
        className="account-code-feedback"
        disabled={!enabled}
        title={
          !conversation
            ? t("Open a session to send feedback.")
            : t("Feedback isn’t available for this session.")
        }
        onClick={start}
      >
        <AppIcon name="Ant" size={20} />
      </IconButton>
      {report &&
        report.accountId === accountId &&
        createPortal(
          <Suspense fallback={null}>
            <CodeFeedbackDialog
              key={report.key}
              conversationId={report.conversationId}
              allowConversationExcerpt={
                report.excerpt &&
                consent !== false &&
                current?.allowConversationExcerpt !== false
              }
              onClose={() => setReport(undefined)}
            />
          </Suspense>,
          document.body,
        )}
    </>
  );
}
