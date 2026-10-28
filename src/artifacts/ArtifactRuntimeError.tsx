import { useState } from "react";
import { X } from "../ui/glyphs";
import "./file-viewer-panel.css";

/**
 * Shown over the preview when its script throws, after the original's card: a
 * 300px card 20px in from the preview's bottom and left with a Dismiss X,
 * "Error running artifact", the sentence about it, the error in a monospace box
 * and a primary "Try fixing with Claude" (here Claudex). Try fixing asks the
 * agent in the artifact's conversation, and the button shows it is busy until
 * the message is sent.
 */
export function ArtifactRuntimeError({
  message,
  onTryFix,
  onDismiss,
  onError,
}: {
  message: string;
  onTryFix?: (message: string) => Promise<void>;
  onDismiss: () => void;
  onError: (error: unknown) => void;
}) {
  const [sending, setSending] = useState(false);
  return (
    <div className="artifact-runtime-error-anchor">
      <div className="artifact-runtime-error" role="alert">
        <strong>Error running artifact</strong>
        <p>An error occurred while trying to run the generated artifact.</p>
        <code>{message}</code>
        {onTryFix && (
          <div className="artifact-runtime-error-actions">
            <button
              className="artifact-try-fixing"
              disabled={sending}
              aria-busy={sending || undefined}
              onClick={() => {
                setSending(true);
                onTryFix(message)
                  .then(onDismiss)
                  .catch((error) => {
                    setSending(false);
                    onError(error);
                  });
              }}
            >
              Try fixing with Claudex
            </button>
          </div>
        )}
        <button
          className="artifact-runtime-error-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
