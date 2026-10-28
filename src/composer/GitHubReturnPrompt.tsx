import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { GitHubReturn } from "../../shared/github-api";
import { api } from "../desktop-api";
import "./github-return.css";

/** The page's title and the reason under it. */
export const githubReturnText = {
  title: "GitHub connection not completed",
  denied:
    "The GitHub authorization was canceled or didn’t go through. You can try again, or pick up where you left off.",
  failed:
    "Something went wrong while connecting to GitHub. You can try again, or pick up where you left off.",
} as const;

/**
 * The page the web Code home shows when the person comes back from GitHub
 * without a connection (`/code?github=denied|failed`): the live app's GitHub
 * callback recovery prompt: a centred column at most 28rem wide, a 28px serif
 * title over the reason, then "Try again" (back to GitHub) and "Go back" (to
 * the Code home under it). Before, the return was dropped without a word.
 */
export function GitHubReturnPrompt({
  cause,
  onClose,
}: {
  cause: Exclude<GitHubReturn, "connected">;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, onClose]);
  const retry = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { authorizeUrl } = await api.githubConnect();
      window.location.assign(authorizeUrl);
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Something went wrong. Try again.",
      );
      setBusy(false);
    }
  };
  return createPortal(
    <div
      className="github-return"
      role="dialog"
      aria-modal="true"
      aria-labelledby="github-return-title"
    >
      <div className="github-return-body" role="status" aria-live="polite">
        <h3 id="github-return-title">{githubReturnText.title}</h3>
        <p>{githubReturnText[cause]}</p>
        {error && (
          <p className="github-return-error" role="alert">
            {error}
          </p>
        )}
        <div className="github-return-actions">
          <button
            type="button"
            className="primary"
            autoFocus
            disabled={busy}
            onClick={() => void retry()}
          >
            Try again
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Go back
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
