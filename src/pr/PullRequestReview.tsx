import { useEffect, useState } from "react";
import type { GitHubPullRequest } from "../../shared/github-api";
import type {
  GitHubCheckAnnotation,
  GitHubPrFile,
  GitHubReviewResult,
} from "../../shared/github-review";
import { api } from "../desktop-api";
import { useApp } from "../app/AppContext";
import { Markdown } from "../ui/Markdown";
import { DiffLines } from "../diff/DiffLines";
import { parseUnifiedDiff } from "../diff/diff-model";
import { t } from "../i18n";
import { ReviewThreadCard } from "../changes/ReviewThreadCard";
import type { GitHubReviewThread } from "../../shared/github-api";
import "./pull-request-review.css";
import "../changes/review-thread.css";
import "../diff/diff.css";
import "../changes/changes-panel.css";

type Section = "files" | "checks" | "timeline";

// PR sections and review actions.
export function PullRequestReview({
  pr,
  section,
}: {
  pr: GitHubPullRequest;
  section: Section;
}) {
  const app = useApp();
  const [result, setResult] = useState<GitHubReviewResult>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState("");
  const [review, setReview] = useState(false);
  const [annotations, setAnnotations] = useState<
    Record<number, GitHubCheckAnnotation[]>
  >({});
  const [threads, setThreads] = useState<GitHubReviewThread[]>([]);
  const [comment, setComment] = useState<{
    file: GitHubPrFile;
    line: number;
    side: "LEFT" | "RIGHT";
  }>();
  useEffect(() => {
    let disposed = false;
    setResult(undefined);
    setError(undefined);
    setAnnotations({});
    setThreads([]);
    void api
      .githubReview({
        repository: pr.repository,
        number: pr.number,
        action: section,
      })
      .then((value) => {
        if (!disposed) setResult(value);
      })
      .catch((reason) => {
        if (!disposed) setError(t(String(reason.message ?? reason)));
      });
    if (section === "files")
      void api
        .githubReview({
          repository: pr.repository,
          number: pr.number,
          action: "threads",
        })
        .then((value) => {
          if (!disposed) setThreads(value.threads ?? []);
        })
        .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [pr.repository, pr.number, pr.headSha, section, tick]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (reason) {
      app.report(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {!result && !error && <p role="status">{t("Loading pull request")}</p>}
      {section === "files" && (
        <>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setReview(!review);
              setComment(undefined);
            }}
          >
            {t("Review changes")}
          </button>
          {review && (
            <form
              className="review-thread-reply"
              onSubmit={(submit) => {
                submit.preventDefault();
                const action = (
                  submit.nativeEvent as SubmitEvent
                ).submitter?.getAttribute("value");
                const event =
                  action === "APPROVE" || action === "REQUEST_CHANGES"
                    ? action
                    : "COMMENT";
                void run(async () => {
                  await api.githubReview({
                    repository: pr.repository,
                    number: pr.number,
                    action: "review",
                    event,
                    ...(body.trim() ? { body } : {}),
                  });
                  setReview(false);
                  setBody("");
                  setTick((value) => value + 1);
                });
              }}
            >
              <textarea
                rows={3}
                aria-label={t("Review comment")}
                value={body}
                readOnly={busy}
                onChange={(change) => setBody(change.target.value)}
              />
              {(["REQUEST_CHANGES", "COMMENT", "APPROVE"] as const).map(
                (action) => (
                  <button
                    key={action}
                    value={action}
                    className={action === "APPROVE" ? "primary" : "secondary"}
                    type="submit"
                    disabled={busy || (action !== "APPROVE" && !body.trim())}
                  >
                    {t(
                      {
                        COMMENT: "Comment",
                        APPROVE: "Approve",
                        REQUEST_CHANGES: "Request changes",
                      }[action],
                    )}
                  </button>
                ),
              )}
              <button
                className="secondary"
                type="button"
                onClick={() => setReview(false)}
              >
                {t("Cancel")}
              </button>
            </form>
          )}
          {result?.files?.map((file) => (
            <section key={file.filename} className="changes-file">
              <div className="changes-file-header">
                <span className="changes-file-name">{file.filename}</span>{" "}
                <span className="changes-add">+{file.additions}</span>{" "}
                <span className="changes-del">−{file.deletions}</span>
              </div>
              {parseUnifiedDiff(file.patch ?? "", file.filename)
                .flatMap((entry) => entry.hunks)
                .map((hunk, index) => (
                  <DiffLines
                    key={index}
                    lines={hunk.lines}
                    onComment={(lineIndex) => {
                      const line = hunk.lines[lineIndex];
                      const number =
                        line.kind === "del" ? line.oldNo : line.newNo;
                      if (number) {
                        setComment({
                          file,
                          line: number,
                          side: line.kind === "del" ? "LEFT" : "RIGHT",
                        });
                        setReview(false);
                        setBody("");
                      }
                    }}
                  />
                ))}
              {threads
                .filter((thread) => thread.path === file.filename)
                .map((thread) => (
                  <ReviewThreadCard
                    key={thread.id}
                    thread={thread}
                    canApply={false}
                    onChanged={() => setTick((value) => value + 1)}
                    onResolve={() =>
                      api.githubReview({
                        repository: pr.repository,
                        number: pr.number,
                        action: "resolve",
                        threadId: thread.id,
                      })
                    }
                    onReply={(body) =>
                      api.githubReview({
                        repository: pr.repository,
                        number: pr.number,
                        action: "threadReply",
                        threadId: thread.id,
                        body,
                      })
                    }
                  />
                ))}
              {comment?.file.filename === file.filename && (
                <form
                  className="review-thread-reply"
                  onSubmit={(submit) => {
                    submit.preventDefault();
                    if (!pr.headSha) return;
                    void run(async () => {
                      await api.githubReview({
                        repository: pr.repository,
                        number: pr.number,
                        action: "comment",
                        commitSha: pr.headSha!,
                        path: file.filename,
                        line: comment.line,
                        side: comment.side,
                        body,
                      });
                      setComment(undefined);
                      setBody("");
                      setTick((value) => value + 1);
                    });
                  }}
                >
                  <textarea
                    aria-label={t("Review comment")}
                    value={body}
                    onChange={(change) => setBody(change.target.value)}
                  />
                  <button
                    className="secondary"
                    type="submit"
                    disabled={busy || !body.trim() || !pr.headSha}
                  >
                    {t("Comment")}
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setComment(undefined)}
                  >
                    {t("Cancel")}
                  </button>
                </form>
              )}
            </section>
          ))}
        </>
      )}
      {section === "timeline" &&
        result?.timeline?.map((entry, index) => (
          <article key={`${entry.id}:${index}`}>
            <span>{entry.actor?.login ?? entry.user?.login}</span>
            <span> {entry.event ?? entry.state}</span>
            {entry.body && <Markdown text={entry.body} />}
          </article>
        ))}
      {section === "checks" &&
        result?.checks?.map((check) => (
          <section key={check.id}>
            <div className="pr-review-check">
              <button
                className="pr-ghost"
                type="button"
                onClick={() =>
                  void run(async () => {
                    const data = await api.githubReview({
                      repository: pr.repository,
                      number: pr.number,
                      action: "annotations",
                      checkRunId: check.id,
                    });
                    setAnnotations((old) => ({
                      ...old,
                      [check.id]: data.annotations ?? [],
                    }));
                  })
                }
              >
                {check.name}
              </button>
              <span>{check.conclusion ?? check.status}</span>
              {check.html_url && (
                <a
                  href={check.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("Open on GitHub")}
                </a>
              )}
              <button
                className="pr-ghost"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.githubReview({
                      repository: pr.repository,
                      number: pr.number,
                      action: "rerun",
                      checkRunId: check.id,
                    });
                    setTick((value) => value + 1);
                  })
                }
              >
                {t("Re-run check")}
              </button>
            </div>
            {annotations[check.id] && (
              <div className="pr-review-annotations">
                {annotations[check.id].length ? (
                  annotations[check.id].map((annotation, index) => (
                    <div key={index}>
                      <code>
                        {annotation.path}:{annotation.start_line}
                      </code>
                      <p>
                        {annotation.title && (
                          <strong>{annotation.title} </strong>
                        )}
                        {annotation.message}
                      </p>
                    </div>
                  ))
                ) : (
                  <p>
                    {t("No inline annotations. Open the run for the full log.")}
                  </p>
                )}
              </div>
            )}
          </section>
        ))}
    </>
  );
}
