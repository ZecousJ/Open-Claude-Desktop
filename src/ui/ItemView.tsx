import { Brain, FileDiff, SquareTerminal, Check, ChevronRight } from "./glyphs";
import type { Item, Mode, Turn } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { AgentMessageAttribution } from "../transcript/agents/AgentMessageAttribution";
import { withoutPrTags } from "../../shared/pr-tags";
import {
  FileChangeView,
  OutputFilesView,
} from "../transcript/tools/FileChangeView";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { Markdown } from "./Markdown";
import { CommandActivity } from "./CommandView";
import { McpToolView } from "../transcript/tools/McpToolView";
import { DynamicToolView } from "../transcript/tools/DynamicToolView";
import { CollaborationToolView } from "../transcript/tools/CollaborationToolView";
import { SessionToolView } from "../transcript/tools/SessionToolView";
import { WebSearchView } from "../transcript/tools/WebSearchView";
import type { Artifact } from "./ArtifactTypes";
import { CodeCommandActivity } from "../code-tools/CodeCommandActivity";
import { CodeFileChange } from "../code-tools/CodeFileChange";
import { CodeToolCall, isCodeToolCall } from "../code-tools/CodeToolCall";
import { ThinkingInline } from "../code-tools/ThinkingInline";
import { isWebFetch } from "../../shared/web-fetch-item";
import { WebFetchRow } from "../transcript/tools/WebFetchRow";
import { useThoughtExpansion } from "../transcript/thought-expansion";
import { isSteeredMessage } from "../../shared/agent-api";
import { SteeredMessage } from "../transcript/UserMessage";
import { ActivityMark } from "../transcript/TurnActivity";
import { ChatPlanRow } from "../plan/ChatPlanRow";
import { showsThinking } from "../../shared/transcript-view";
import { useTranscriptViewContext } from "../transcript-view/transcript-view-store";
import { useTranscriptSlots } from "../transcript/transcript-slots";
import { Suspense } from "react";
import { lazyPiece } from "./lazy-piece";
const PlanCommentText = lazyPiece(
  () => import("../plan/PlanComments"),
  "PlanCommentText",
);
export function ItemView({
  item,
  onArtifact,
  mode,
  turnStatus,
  startedAt,
  needsInput,
}: {
  item: Item;
  onArtifact: (artifact: Artifact) => void;
  mode?: Mode;
  turnStatus?: Turn["status"];
  startedAt?: number;
  needsInput?: boolean;
}) {
  const view = useTranscriptViewContext();
  const [thoughtOpen, setThoughtOpen] = useThoughtExpansion(
    `${startedAt ?? ""}:thinking:${item.id}`,
  );
  const CodeThought = useTranscriptSlots().CodeThought;
  if (turnStatus && turnStatus !== "inProgress" && itemIsRunning(item))
    item = { ...item, lifecycleStatus: turnStatus };
  // A message sent while the turn ran appears where the model read it (E0).
  if (isSteeredMessage(item)) return <SteeredMessage item={item} />;
  if (item.type === "outputFiles")
    return <OutputFilesView item={item} onArtifact={onArtifact} />;
  if (item.type === "fileChange" && mode === "chat")
    return <FileChangeView item={item} onArtifact={onArtifact} />;
  if (item.type === "commandExecution" && mode === "chat")
    return <CommandActivity item={item} startedAt={startedAt} />;
  if (item.type === "commandExecution" && mode === "code")
    return <CodeCommandActivity item={item} />;
  if (item.type === "fileChange" && mode === "code")
    return <CodeFileChange item={item} onArtifact={onArtifact} />;
  if (item.type === "plan" && mode === "code")
    return (
      <div
        className="markdown plan-message"
        data-streaming={itemIsRunning(item) || undefined}
      >
        <Suspense
          fallback={
            <Markdown
              text={withoutPrTags(item.text ?? "")}
              onArtifact={onArtifact}
              streaming={itemIsRunning(item)}
            />
          }
        >
          <PlanCommentText
            planId={item.id}
            text={withoutPrTags(item.text ?? "")}
            onArtifact={onArtifact}
            streaming={itemIsRunning(item)}
          />
        </Suspense>
      </div>
    );
  if (
    item.type === "agentMessage" ||
    item.type === "plan" ||
    item.type === "peerMessage"
  )
    return (
      <div
        className={`markdown prose ${item.type === "plan" ? "plan-message" : ""}`}
        data-cds="Prose"
        data-streaming={itemIsRunning(item) || undefined}
      >
        <AgentMessageAttribution item={item} />
        <Markdown
          // Claude's <pr-created> tag is for the branch row; here it is the link.
          text={
            mode === "code" ? withoutPrTags(item.text ?? "") : (item.text ?? "")
          }
          onArtifact={onArtifact}
          streaming={itemIsRunning(item)}
        />
      </div>
    );
  if (item.type === "agentNotice" && item.notice === "agents_killed")
    return <AgentMessageAttribution item={item} />;
  if (item.type === "reasoning") {
    const text = item.summary?.join("\n\n");
    // The Thinking and Verbose views show the thinking itself in the
    // transcript, muted and italic after a rule, instead of the folded step.
    if (text && mode === "code" && showsThinking(view))
      return <ThinkingInline text={text} />;
    // The phones fold a thought into the official row that opens its sheet.
    if (text && mode === "code" && CodeThought)
      return <CodeThought item={item} />;
    return text ? (
      <details
        className="activity reasoning"
        open={thoughtOpen}
        onToggle={(event) => {
          if (event.currentTarget.open !== thoughtOpen)
            setThoughtOpen(event.currentTarget.open);
        }}
      >
        <summary>
          <Brain size={15} />
          Thought process
          <ChevronRight size={13} />
        </summary>
        <div className="activity-body markdown">
          <Markdown text={text} onArtifact={onArtifact} />
        </div>
      </details>
    ) : null;
  }
  if (item.type === "diff") return null;
  if (isWebFetch(item)) return <WebFetchRow item={item} />;
  if (item.type === "webSearch")
    return <WebSearchView item={item} code={mode === "code"} />;
  if (mode === "code" && isCodeToolCall(item))
    return <CodeToolCall item={item} />;
  if (item.type === "mcpToolCall")
    return <McpToolView item={item} needsInput={needsInput} />;
  if (item.type === "dynamicToolCall")
    return <DynamicToolView item={item} needsInput={needsInput} />;
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity")
    return <CollaborationToolView item={item} chat={mode === "chat"} />;
  if (
    [
      "imageGeneration",
      "imageView",
      "sleep",
      "contextCompaction",
      "enteredReviewMode",
      "exitedReviewMode",
    ].includes(item.type)
  )
    return <SessionToolView item={item} onArtifact={onArtifact} />;
  if (item.type === "taskPlan") return <ChatPlanRow item={item} />;
  const running = itemIsRunning(item);
  const command = item.type === "commandExecution";
  const change = item.type === "fileChange";
  const label = command
    ? running
      ? "Running a command"
      : item.lifecycleStatus === "interrupted"
        ? "Command stopped"
        : "Ran a command"
    : change
      ? `Edited ${item.changes?.length ?? 0} files`
      : item.type === "mcpToolCall"
        ? `${item.server} · ${item.tool}`
        : item.type === "webSearch"
          ? "Searched the web"
          : item.type === "contextCompaction"
            ? "Compacted session"
            : item.type;
  return (
    <details className={`activity ${item.status === "failed" ? "failed" : ""}`}>
      <summary>
        {running ? (
          <ActivityMark phase="tools" />
        ) : command ? (
          <SquareTerminal size={15} />
        ) : change ? (
          <FileDiff size={15} />
        ) : (
          <Check size={15} />
        )}
        <span>{label}</span>
        {command && <code>{item.command?.slice(0, 85)}</code>}
        <ChevronRight size={13} />
      </summary>
      <div className="activity-body">
        {command ? (
          <>
            <div className="path">{item.cwd}</div>
            <pre>
              $ {item.command}
              {"\n\n"}
              {item.aggregatedOutput || ""}
            </pre>
            {item.exitCode != null && <small>Exit code {item.exitCode}</small>}
          </>
        ) : change ? (
          item.changes?.map((c, i) => (
            <div key={i}>
              <strong>{c.path}</strong>
              {item.generatedFiles?.[i]?.state === "ready" && (
                <button
                  className="small-action"
                  onClick={() => {
                    const file = generatedArtifact(item.generatedFiles![i]);
                    if (file) onArtifact(file);
                  }}
                >
                  Open file
                </button>
              )}
              <pre className="diff">{c.diff}</pre>
            </div>
          ))
        ) : (
          <pre>
            {JSON.stringify(item.result ?? item.error ?? item, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}
