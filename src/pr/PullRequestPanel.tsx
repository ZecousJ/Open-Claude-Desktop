import { Suspense, useState } from "react";
import type { Conversation } from "../../shared/types";
import { lazyPiece } from "../ui/lazy-piece";
import "./pull-request-review.css";
import { useApp } from "../app/AppContext";
import { SessionPaneFrame } from "../app/SessionPaneFrame";
import { Markdown } from "../ui/Markdown";
import { t } from "../i18n";
import { api } from "../desktop-api";
import { useBranchRow } from "./useBranchRow";
import PullRequestBar from "./PullRequestBar";
const PullRequestReview = lazyPiece(
  () => import("./PullRequestReview"),
  "PullRequestReview",
);

export function PullRequestPanel({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const app = useApp();
  const { pr, problem, ref } = useBranchRow(conversation);
  const [section, setSection] = useState<
    "overview" | "files" | "checks" | "timeline"
  >("overview");
  return (
    <SessionPaneFrame pane="pr" title="Pull request" onClose={onClose}>
      <div className="pull-request-pane-body">
        <div className="pull-request-pane-content">
          {pr ? (
            <>
              <div
                className="pr-review-tabs"
                role="tablist"
                aria-label={t("Pull request sections")}
              >
                {(["overview", "files", "checks", "timeline"] as const).map(
                  (value) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      tabIndex={section === value ? 0 : -1}
                      aria-selected={section === value}
                      onClick={() => setSection(value)}
                      onKeyDown={(event) => {
                        const tabs = [
                          "overview",
                          "files",
                          "checks",
                          "timeline",
                        ] as const;
                        const index = tabs.indexOf(value);
                        const next =
                          event.key === "ArrowRight"
                            ? (index + 1) % tabs.length
                            : event.key === "ArrowLeft"
                              ? (index + tabs.length - 1) % tabs.length
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? tabs.length - 1
                                  : undefined;
                        if (next !== undefined) {
                          event.preventDefault();
                          setSection(tabs[next]);
                          (
                            event.currentTarget.parentElement?.children[
                              next
                            ] as HTMLElement
                          )?.focus();
                        }
                      }}
                    >
                      {t(
                        {
                          overview: "Overview",
                          timeline: "Timeline",
                          files: "Files",
                          checks: "Checks",
                        }[value],
                      )}
                    </button>
                  ),
                )}
              </div>
              {section !== "overview" ? (
                <Suspense fallback={null}>
                  <PullRequestReview
                    key={`${pr.repository}:${pr.number}:${section}`}
                    pr={pr}
                    section={section}
                  />
                </Suspense>
              ) : (
                <>
                  <span>
                    {pr.repository} #{pr.number}
                  </span>
                  <h2>{pr.title}</h2>
                  <span>
                    {pr.headRef} → {pr.baseRef}
                  </span>
                  <span>
                    +{pr.additions ?? 0} −{pr.deletions ?? 0}
                  </span>
                  {pr.body ? (
                    <Markdown text={pr.body} />
                  ) : (
                    <p>{t("No description provided.")}</p>
                  )}
                </>
              )}
            </>
          ) : (
            <p role="status">
              {t(
                problem
                  ? "Couldn’t load pull request details. Try again."
                  : ref
                    ? "Loading pull request"
                    : "No pull request for this branch yet.",
              )}
            </p>
          )}
          <PullRequestBar
            conversation={conversation}
            openLink={(url) => void api.openExternal(url).catch(app.report)}
            send={async (text) => {
              const next = await api.send({
                conversationId: conversation.id,
                text,
                attachments: [],
                mode: conversation.mode,
                providerId: conversation.providerId,
                model: conversation.model,
              });
              app.upsert(next);
            }}
          />
        </div>
      </div>
    </SessionPaneFrame>
  );
}
