import type { Turn } from "../../../shared/types";
import { CopyButton } from "../../ui/Controls";
import { ReplyCopyIcon } from "../../ui/ReplyIcons";
import { t, useT } from "../../i18n";

/**
 * The actions under an earlier Code reply on the phones: Copy only. The
 * desktop's toolbar also carries Fork from here, Pin as chapter and the time;
 * the official Android app has no such controls (its strings hold no fork or
 * chapter at all), so they are not drawn here.
 */
export function OfficialCodeReplyActions({ turn }: { turn: Turn }) {
  useT();
  const text = turn.items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text ?? "")
    .join("\n\n");
  if (!text) return null;
  return (
    <div
      className="message-actions code-reply-actions"
      role="toolbar"
      aria-label={t("Message actions")}
    >
      <CopyButton
        iconOnly
        text={text}
        glyph={<ReplyCopyIcon />}
        message="reply"
      />
    </div>
  );
}

/** "Scroll to bottom" after the arrow: Code's pill. */
export function OfficialScrollLabel() {
  useT();
  return <span className="scroll-bottom-label">{t("Scroll to bottom")}</span>;
}
