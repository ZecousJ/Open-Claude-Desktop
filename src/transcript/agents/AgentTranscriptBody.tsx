import type { Item } from "../../../shared/types";
import { ItemView, Markdown } from "../../ui/components";
import { AgentCommandGroup } from "./AgentCommandGroup";
import { AgentMessageAttribution } from "./AgentMessageAttribution";
import { t } from "../../i18n";
import "./agent-messages.css";

const visibleToolTypes = new Set([
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "fileChange",
  "taskPlan",
  "plan",
  "imageGeneration",
  "imageView",
  "sleep",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
  "collabAgentToolCall",
  "subAgentActivity",
  "agentNotice",
]);

type Group = { id: string; commands?: Item[]; item?: Item };
export function agentTranscriptGroups(items: Item[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (item.type === "commandExecution" && last?.commands)
      last.commands.push(item);
    else if (item.type === "commandExecution")
      groups.push({ id: item.id, commands: [item] });
    else groups.push({ id: item.id, item });
  }
  return groups;
}
function AgentTranscriptItem({ item }: { item: Item }) {
  if (["agentMessage", "peerMessage"].includes(item.type) && item.text)
    return (
      <div className="agent-transcript-message markdown">
        <AgentMessageAttribution item={item} />
        <Markdown text={item.text} onArtifact={() => {}} />
      </div>
    );
  if (item.type === "reasoning" && item.summary?.length)
    return (
      <div className="agent-transcript-thinking">{item.summary.join(" ")}</div>
    );
  if (visibleToolTypes.has(item.type))
    return <ItemView item={item} onArtifact={() => {}} />;
  return null;
}
export function AgentTranscriptBody({
  items,
  truncated = false,
}: {
  items: Item[];
  truncated?: boolean;
}) {
  return (
    <>
      {truncated && (
        <div className="agent-transcript-truncated">
          <span>
            {t(
              "Some agent activity isn’t shown. This session is too large to load in full.",
            )}
          </span>
        </div>
      )}
      {agentTranscriptGroups(items).map((group, index) => (
        <div className="agent-transcript-group" key={`${group.id}:${index}`}>
          {group.commands ? (
            <AgentCommandGroup commands={group.commands} />
          ) : group.item ? (
            <AgentTranscriptItem item={group.item} />
          ) : null}
        </div>
      ))}
    </>
  );
}
