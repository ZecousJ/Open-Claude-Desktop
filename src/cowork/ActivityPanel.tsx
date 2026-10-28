import type { Conversation } from "../../shared/types";
import { artifactsIn, type Artifact } from "../ui/ArtifactTypes";
import { ProgressPanel } from "./ProgressPanel";
import "./activity-panel.css";
import { IconButton } from "../ui/Controls";
import { AppIcon } from "../ui/app-icon";
import { ActivityIllustration } from "./ActivityIllustration";

/** Keep existing files, tools and research actionable; a plain reply alone
 * does not constitute activity in the captured unified session. */
export function hasSessionActivity(conversation: Conversation) {
  return conversation.turns.some(
    (turn) =>
      Boolean(turn.research) ||
      turn.attachments.length > 0 ||
      turn.items.some(
        (item) =>
          (item.type !== "agentMessage" && item.type !== "reasoning") ||
          item.generatedFiles?.some((file) => file.state !== "deleted") ||
          (item.type === "agentMessage" &&
            artifactsIn(item.text ?? "", item.id).length > 0),
      ),
  );
}

export function ActivityPanel({
  conversation,
  onArtifact,
  onClose,
  embedded = false,
}: {
  conversation: Conversation;
  onArtifact: (artifact: Artifact) => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  const Root = embedded ? "div" : "aside";
  if (conversation.mode !== "code" && !hasSessionActivity(conversation))
    return (
      <Root
        className="work-panel session-activity-panel"
        aria-label="Session activity panel"
        role={embedded ? "region" : undefined}
      >
        {!embedded && (
          <IconButton
            label="Close activity panel"
            className="session-activity-close"
            onClick={onClose}
          >
            <AppIcon name="XBase" size={16} />
          </IconButton>
        )}
        <div className="session-activity-empty">
          <div className="session-activity-illustration" aria-hidden="true">
            <ActivityIllustration />
          </div>
          <h3>Nothing here yet</h3>
          <p>Files Claudex makes and tools it uses will show up here.</p>
        </div>
      </Root>
    );
  return (
    <ProgressPanel
      conversation={conversation}
      onArtifact={onArtifact}
      embedded={embedded}
    />
  );
}
