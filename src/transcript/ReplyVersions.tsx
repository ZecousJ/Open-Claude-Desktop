import { ChevronLeft, ChevronRight } from "../ui/glyphs";
import { ReplyRetryIcon } from "../ui/ReplyIcons";
import { WithTooltip } from "../ui/Tooltip";
import { replyVersions } from "../../shared/branches";
import type { Conversation, Turn } from "../../shared/types";

export function ReplyVersions({
  conversation,
  turn,
  busy,
  onRetry,
  onSelect,
}: {
  conversation: Conversation;
  turn: Turn;
  busy: boolean;
  onRetry: () => void;
  onSelect: (versionTurnId: string) => void;
}) {
  const versions = replyVersions(conversation, turn);
  const current = versions.findIndex((v) => v.turnId === turn.id);
  return (
    <>
      <WithTooltip label="Retry">
        {(tooltip) => (
          <button
            {...tooltip}
            className="small-action icon-only"
            aria-label="Retry"
            disabled={busy}
            onClick={onRetry}
          >
            <ReplyRetryIcon />
          </button>
        )}
      </WithTooltip>
      {versions.length > 1 && (
        <div className="reply-versions" aria-label="Reply versions">
          <WithTooltip label="Previous version">
            {(tooltip) => (
              <button
                {...tooltip}
                className="small-action icon-only"
                aria-label="Previous version"
                disabled={busy || current <= 0}
                onClick={() => onSelect(versions[current - 1].turnId)}
              >
                <ChevronLeft size={12} />
              </button>
            )}
          </WithTooltip>
          <span aria-live="polite">
            {current + 1} / {versions.length}
          </span>
          <WithTooltip label="Next version">
            {(tooltip) => (
              <button
                {...tooltip}
                className="small-action icon-only"
                aria-label="Next version"
                disabled={busy || current >= versions.length - 1}
                onClick={() => onSelect(versions[current + 1].turnId)}
              >
                <ChevronRight size={12} />
              </button>
            )}
          </WithTooltip>
        </div>
      )}
    </>
  );
}
