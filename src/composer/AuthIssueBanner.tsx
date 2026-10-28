import { useEffect, useState, useSyncExternalStore } from "react";
import {
  authIssueCopy,
  turnAuthIssue,
  type AuthIssue,
} from "../../shared/auth-issue";
import { useT } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { voiceAuthIssue } from "../voice/auth-issue";
import "./auth-issue.css";

export function AuthIssueBanner({
  error,
  turnId,
}: {
  error?: string;
  turnId?: string;
}) {
  const [sessionIssue, setSessionIssue] = useState<AuthIssue | null>(null);
  const [dismissed, setDismissed] = useState("");
  const voiceIssue = useSyncExternalStore(
    voiceAuthIssue.subscribe,
    voiceAuthIssue.read,
    () => null,
  );
  useEffect(
    () =>
      window.desktop.onEvent((event) => {
        if (event.type === "auth-issue") {
          setSessionIssue(event.issue);
          setDismissed(
            event.issue === null
              ? `${turnAuthIssue(error)}:${turnId ?? ""}`
              : "",
          );
        }
      }),
    [error, turnId],
  );
  const issue = voiceIssue ?? sessionIssue ?? turnAuthIssue(error);
  const key = `${issue}:${turnId ?? ""}`;
  if (!issue || (!voiceIssue && dismissed === key)) return null;
  return (
    <AuthIssueNotice
      issue={issue}
      onDismiss={
        issue === "retrying"
          ? undefined
          : () => {
              if (voiceIssue) voiceAuthIssue.set(null);
              setDismissed(key);
            }
      }
    />
  );
}

export function AuthIssueNotice({
  issue,
  onDismiss,
}: {
  issue: AuthIssue;
  onDismiss?: () => void;
}) {
  const t = useT();
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      <div
        className="auth-issue-banner"
        data-cds="Banner"
        data-variant="warning"
        data-testid="voice-status-banner"
      >
        <span className="auth-issue-icon">
          <AppIcon name="Warning" />
        </span>
        <span className="auth-issue-copy">{t(authIssueCopy[issue])}</span>
        {onDismiss && (
          <span className="auth-issue-dismiss-slot">
            <button
              type="button"
              className="auth-issue-dismiss"
              aria-label={t("Dismiss")}
              onClick={onDismiss}
            >
              <AppIcon name="X" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
