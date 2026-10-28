import { ChevronRight } from "../ui/glyphs";
import type { Item, Turn } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import type { Artifact } from "../ui/ArtifactTypes";
import { ItemView } from "../ui/ItemView";
import { CodeCommandActivity, ToolSummaryText } from "./CodeCommandActivity";
import { DiffStat, itemsDiffTotals } from "./CodeFileChange";
import {
  useTranscriptViewContext,
  verboseOpen,
} from "../transcript-view/transcript-view-store";

/**
 * One or more consecutive tool calls in a Code turn. A single command keeps its
 * own disclosure; several fold into one summary row whose body lists each call.
 */
export function CodeToolGroup({
  items,
  turnStatus,
  startedAt,
  background,
  onOpenBackground,
  onArtifact,
}: {
  items: Item[];
  turnStatus: Turn["status"];
  startedAt: number;
  /** Command item ids Codex still lists as background terminals. */
  background: Set<string>;
  onOpenBackground: () => void;
  onArtifact: (artifact: Artifact) => void;
}) {
  const view = useTranscriptViewContext();
  const normalized = items.map((item) =>
    turnStatus !== "inProgress" && itemIsRunning(item)
      ? { ...item, lifecycleStatus: turnStatus }
      : item,
  );
  const row = (item: Item) =>
    item.type === "commandExecution" ? (
      <CodeCommandActivity
        key={item.id}
        item={item}
        background={background.has(item.id)}
        onOpenBackground={onOpenBackground}
      />
    ) : (
      <ItemView
        key={item.id}
        item={item}
        mode="code"
        turnStatus={turnStatus}
        startedAt={startedAt}
        onArtifact={onArtifact}
      />
    );
  if (normalized.length === 1) return row(normalized[0]);
  const running = normalized.some(itemIsRunning);
  // The summary ends with the lines the group's edits added and removed.
  const stat = itemsDiffTotals(normalized);
  return (
    <details className="code-command code-tool-group" open={verboseOpen(view)}>
      <summary>
        <span
          className="code-command-label"
          data-running={running || undefined}
        >
          <ToolSummaryText items={normalized} />
        </span>
        {stat.files > 0 && (
          <DiffStat
            additions={stat.additions}
            deletions={stat.deletions}
            pill
          />
        )}
        <ChevronRight size={16} strokeWidth={1.75} />
      </summary>
      <div className="code-tool-group-items">{normalized.map(row)}</div>
    </details>
  );
}
