import { TurnConnectionNotice } from "./TurnConnectionNotice";
import { AgentMessageAttribution } from "./agents/AgentMessageAttribution";
import { lazyPiece, preloadPiece } from "../ui/lazy-piece";
import { AssistantMessage } from "./AssistantMessage";
import { messageSummary } from "./message-summary";
import { messageTextSize, transcriptTextSize } from "./transcript-text-size";
import { FileChangeView } from "./tools/FileChangeView";
import { LocalFileLinks, localFileResolver } from "./local-file-links";
import { RunningWorkflow } from "./workflow/RunningWorkflow";
import { WorkflowCard } from "./workflow/WorkflowCard";
import { SingleAgentEvent } from "./agents/SingleAgentEvent";
import { isWorkflowItem, tasksFromTurn } from "../../shared/workflow-model";
import {
  agentOpener,
  taskForItem,
  type AgentTarget,
} from "./agents/AgentItems";
import {
  Fragment,
  Suspense,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { prefersReducedMotion } from "../ui/usePresence";
import { AppContext } from "../app/AppContext";
import { ResearchCard } from "../research/ResearchCard";
import {
  openResearchPanel,
  useTurnResearch,
} from "../research/useResearchDraft";
import { WebSearchView, isSearchItem } from "./tools/WebSearchView";
import { citationRender, turnSources } from "../citations/citations";
import { useTranscriptSlots } from "./transcript-slots";
import type { Conversation, Item, Turn } from "../../shared/types";
import { electionInfoSource } from "../../shared/message-resources";
const ModelSwitchNote = lazyPiece(
  () => import("./ModelSwitchNote"),
  "ModelSwitchNote",
);
const ElectionInfoSource = lazyPiece(
  () => import("./tools/ElectionInfoSource"),
  "ElectionInfoSource",
);
export const preloadElectionInfoSource = () => preloadPiece(ElectionInfoSource);
const ChatStepsGroup = lazyPiece(
  () => import("./ChatStepsGroup"),
  "ChatStepsGroup",
);
const ResearchReport = lazyPiece(
  () => import("../research/ResearchReport"),
  "ResearchReport",
);
export const preloadChatSteps = () => preloadPiece(ChatStepsGroup);
import { itemIsRunning, turnActivity } from "../../shared/activity";
import { tf } from "../i18n";
import { TurnActivity } from "./TurnActivity";
import { ItemView, Markdown, type Artifact } from "../ui/components";
import { chatSegments, ActivityGroup } from "./ChatActivityGroup";

export const TOOL_TYPES = ["mcpToolCall", "dynamicToolCall"];
const ChatSuggestions = lazyPiece(
  () => import("../chat-suggestions/ChatSuggestions"),
);
/** Research's own app tools; the Research card stands for them (design R45 §4.3). */
const RESEARCH_TOOLS = [
  "research_plan",
  "research_report",
  "research_start_report",
];
const isResearchTool = (item: Item) =>
  item.type === "dynamicToolCall" &&
  !!item.tool &&
  RESEARCH_TOOLS.includes(item.tool);
export const isTool = (segment: { activity: boolean; items: Item[] }) =>
  !segment.activity &&
  segment.items.length === 1 &&
  TOOL_TYPES.includes(segment.items[0].type);

/** Chat, or Cowork, which uses Chat's light rows in a timeline. */
export type ChatVariant = "chat" | "cowork";

/**
 * While the model reasons, the label becomes the reasoning summary's title
 * ("Explaining how streaming output works", agent-lifecycle-001 17–21s): its
 * heading, or else its first sentence. Before any summary it keeps the turn's verb.
 */
export function thoughtTitle(items: Item[], fallback = "Contemplating") {
  const reasoning = items.filter((item) => item.type === "reasoning").at(-1);
  const first = reasoning?.summary?.join("\n").trim().split("\n")[0]?.trim();
  if (!first) return fallback;
  const heading = first.match(/^(?:\*\*([^*]+)\*\*|#{1,3} (.+))$/);
  let title = (heading?.[1] ?? heading?.[2] ?? first)
    .replace(/[*_`]/g, "")
    .trim();
  if (!heading) title = title.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? title;
  title = title.replace(/[.:]$/, "");
  if (title.length > 80)
    title = `${title.slice(0, 80).replace(/\s+\S*$/, "")}…`;
  return title || fallback;
}

/**
 * How a row joins Cowork's timeline (the original's timeline block entrance):
 * 430ms from transparent,
 * blurred 4px, 5px down and at 90% about its left edge; the move settles in
 * the first 30% on cubic-bezier(0.22, 1, 0.36, 1), then the fade and the
 * blur finish, ease-out.
 */
const TIMELINE_ARRIVAL: Keyframe[] = [
  {
    offset: 0,
    opacity: 0,
    filter: "blur(4px)",
    transform: "translateY(5px) scale(0.9)",
    transformOrigin: "left center",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  {
    offset: 0.3,
    opacity: 0,
    filter: "blur(4px)",
    transform: "none",
    transformOrigin: "left center",
    easing: "ease-out",
  },
  { offset: 1, opacity: 1, filter: "none", transform: "none" },
];

/**
 * Plays the timeline entrance on each row added to `list` after it first
 * showed; the rows it opened with, or reopened with, stay as they are.
 * Reduced motion: rows appear at once.
 */
export function useTimelineArrivals(list: RefObject<HTMLElement | null>) {
  const seen = useRef<{ parent: Element; rows: WeakSet<Element> }>(null);
  useLayoutEffect(() => {
    const parent = list.current;
    if (!parent) return;
    const rows = [...parent.children];
    if (seen.current?.parent !== parent) {
      seen.current = { parent, rows: new WeakSet(rows) };
      return;
    }
    const known = seen.current.rows;
    const still = prefersReducedMotion();
    for (const row of rows) {
      if (known.has(row)) continue;
      known.add(row);
      if (!still && typeof row.animate === "function")
        row.animate(TIMELINE_ARRIVAL, { duration: 430, fill: "backwards" });
    }
  });
}

/**
 * One transcript item outside an activity group. A finished reply that
 * cites web pages (the gateway's citations, or xAI's `[[1]](url)` links)
 * shows a chip per citation (R5, design R45 §4.6), with the page titles
 * and snippets the turn's searches returned; everything else renders as
 * ItemView does.
 */
function ChatItem({
  item,
  turn,
  needsInput,
  sources,
  onArtifact,
}: {
  item: Item;
  turn: Turn;
  needsInput?: boolean;
  sources: ReturnType<typeof turnSources>;
  onArtifact: (artifact: Artifact) => void;
}) {
  // A finished turn has no running items left (ItemView reads it the same way).
  const running = turn.status === "inProgress" && itemIsRunning(item);
  const cited = useMemo(
    () =>
      item.type === "agentMessage" && !running
        ? citationRender(item, sources)
        : undefined,
    [item, running, sources],
  );
  if (!cited)
    return (
      <ItemView
        item={item}
        mode="chat"
        turnStatus={turn.status}
        startedAt={turn.createdAt}
        needsInput={needsInput}
        onArtifact={onArtifact}
      />
    );
  return (
    <div className="markdown prose cited-message" data-cds="Prose">
      <AgentMessageAttribution item={item} />
      <Markdown
        text={cited.text}
        citations={cited.groups}
        onArtifact={onArtifact}
      />
    </div>
  );
}

/**
 * The connector call that introduced each background agent: it is shown in
 * the agent's "Used a tool" row. A `spawnAgent` collaboration call between
 * the two is skipped (single-agent-user-activity-001).
 */
export function agentPriorTools(turn: Turn, conversation?: Conversation) {
  const tasks = conversation ? tasksFromTurn(turn, conversation) : [];
  const priorTools = new Map<string, Item>();
  for (const task of tasks.filter((task) => task.kind === "agent")) {
    let index = turn.items.findIndex(
      (item) =>
        item.type === "subAgentActivity" &&
        item.agentThreadId === task.agents[0]?.id,
    );
    while (index > 0 && turn.items[index - 1].type === "collabAgentToolCall")
      index--;
    const prior = index > 0 ? turn.items[index - 1] : undefined;
    if (prior && TOOL_TYPES.includes(prior.type))
      priorTools.set(prior.id, prior);
  }
  return { tasks, priorTools };
}

export function ChatTurnContent({
  conversation,
  turn,
  awaitingApproval,
  onArtifact,
  onOpenWorkflow,
  onOpenAgent,
  variant = "chat",
  presentation,
}: {
  conversation?: Conversation;
  turn: Turn;
  awaitingApproval: boolean;
  onArtifact: (artifact: Artifact) => void;
  onOpenWorkflow?: () => void;
  /** Opens a single Agent's transcript; without it the row opens the task list. */
  onOpenAgent?: (target: AgentTarget) => void;
  variant?: ChatVariant;
  /** Presentation only; Cowork workflow and suggestion capabilities stay separate. */
  presentation?: "chat";
}) {
  const displayVariant = presentation ?? variant;
  const { tasks, priorTools } = agentPriorTools(turn, conversation);
  const research = useTurnResearch(conversation, turn);
  const app = useContext(AppContext);
  const slots = useTranscriptSlots();
  const StepsGroup = slots.StepsGroup ?? ChatStepsGroup;
  const Activity = slots.TurnActivity;
  const segments = chatSegments(
    research ? turn.items.filter((item) => !isResearchTool(item)) : turn.items,
    new Set(priorTools.keys()),
    displayVariant,
  );
  // The Research card follows the turn's first reply, or leads the turn.
  const cardAfter = research
    ? segments.find(
        (segment) =>
          !segment.activity && segment.items[0].type === "agentMessage",
      )?.id
    : undefined;
  const researchCard = research && (
    <ResearchCard
      key="research-card"
      turn={turn}
      research={research}
      onOpen={
        app && conversation
          ? () => openResearchPanel(app, conversation.id, turn.id)
          : undefined
      }
    />
  );
  const phase = turnActivity(turn, awaitingApproval);
  const summary = messageSummary(
    turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text ?? "")
      .join("\n\n"),
  );
  const sources = useMemo(() => turnSources(turn), [turn]);
  const electionSource =
    turn.status !== "inProgress" ? electionInfoSource(turn.items) : undefined;
  const resolveFile = useMemo(
    () => localFileResolver(conversation ?? { turns: [turn] }),
    [conversation, turn],
  );
  const last = segments.at(-1);
  const activeGroup =
    turn.status === "inProgress"
      ? ([...segments]
          .reverse()
          .find(
            (segment) => segment.activity && segment.items.some(itemIsRunning),
          )?.id ??
        (last?.activity && phase !== "streaming" ? last.id : undefined))
      : undefined;
  const agentFor = (item: Item) => {
    const index = turn.items.indexOf(item);
    let before = index - 1;
    while (before > 0 && turn.items[before].type === "collabAgentToolCall")
      before--;
    return priorTools.get(turn.items[before]?.id);
  };
  const rendered = segments.map((segment) =>
    priorTools.has(segment.id) ? null : segment.activity &&
      displayVariant === "chat" ? (
      <Suspense key={segment.id} fallback={null}>
        <StepsGroup
          items={segment.items}
          turn={turn}
          active={activeGroup === segment.id}
          awaitingApproval={awaitingApproval}
          onArtifact={onArtifact}
        />
      </Suspense>
    ) : segment.activity ? (
      <ActivityGroup
        key={segment.id}
        items={segment.items}
        turn={turn}
        active={activeGroup === segment.id}
        awaitingApproval={awaitingApproval}
        onArtifact={onArtifact}
        variant={variant}
      />
    ) : isWorkflowItem(segment.items[0]) ? (
      (() => {
        const task = taskForItem(segment.items[0], turn, tasks);
        if (!task) return null;
        if (task.kind === "agent")
          return (
            <SingleAgentEvent
              key={`${segment.id}:${task.id}`}
              task={task}
              priorTool={agentFor(segment.items[0])}
              onOpen={agentOpener(
                task,
                onOpenWorkflow ?? (() => {}),
                onOpenAgent,
              )}
            />
          );
        // Cowork shows a workflow's progress only in its side panel (S-0008).
        if (variant === "cowork")
          return task.status === "running" ? (
            <RunningWorkflow key={segment.id} startedAt={task.startedAt} />
          ) : null;
        return (
          <WorkflowCard
            key={segment.id}
            workflow={task}
            onOpen={onOpenWorkflow ?? (() => {})}
          />
        );
      })()
    ) : segment.items[0].type === "fileChange" ? (
      <FileChangeView
        key={segment.id}
        item={segment.items[0]}
        items={segment.items.map((item) =>
          turn.status !== "inProgress" && itemIsRunning(item)
            ? { ...item, lifecycleStatus: turn.status }
            : item,
        )}
        startedAt={turn.createdAt}
        onArtifact={onArtifact}
      />
    ) : segment.items.length > 1 && isSearchItem(segment.items[0]) ? (
      <WebSearchView
        key={segment.id}
        item={segment.items[0]}
        items={segment.items.map((item) =>
          turn.status !== "inProgress" && itemIsRunning(item)
            ? { ...item, lifecycleStatus: turn.status }
            : item,
        )}
      />
    ) : (
      <ChatItem
        key={segment.id}
        item={segment.items[0]}
        turn={turn}
        needsInput={
          phase === "approval" &&
          segment.items[0].id === turn.items.filter(itemIsRunning).at(-1)?.id
        }
        sources={sources}
        onArtifact={onArtifact}
      />
    ),
  );
  return (
    <LocalFileLinks.Provider value={resolveFile}>
      <AssistantMessage
        bubble={
          displayVariant === "chat" && conversation?.sessionAuthors != null
        }
        frame={displayVariant === "chat"}
        busy={turn.status === "inProgress"}
        textSize={messageTextSize(transcriptTextSize(app?.snapshot.settings))}
        heading={summary ? tf("Claudex responded: {summary}", { summary }) : ""}
      >
        {research && !cardAfter && researchCard}
        {segments.map((segment, index) => (
          <Fragment key={segment.id}>
            {rendered[index]}
            {segment.id === cardAfter && researchCard}
          </Fragment>
        ))}
        {conversation &&
          research?.state === "done" &&
          research.reportSource === "tool" &&
          research.report && (
            <Suspense fallback={null}>
              <ResearchReport
                conversationId={conversation.id}
                turnId={turn.id}
                onArtifact={onArtifact}
              />
            </Suspense>
          )}
        {!activeGroup && displayVariant === "chat" && Activity && (
          <Activity turn={turn} awaitingApproval={awaitingApproval} />
        )}
        {!activeGroup && !(displayVariant === "chat" && Activity) && (
          <TurnActivity
            turn={turn}
            awaitingApproval={awaitingApproval}
            startingUp={variant === "cowork"}
          />
        )}
        <TurnConnectionNotice turn={turn} />
        {turn.switchedTo && (
          <Suspense fallback={null}>
            <ModelSwitchNote model={turn.switchedTo} />
          </Suspense>
        )}
        {electionSource && (
          <Suspense fallback={null}>
            <ElectionInfoSource url={electionSource} />
          </Suspense>
        )}
      </AssistantMessage>
      {variant === "chat" &&
        conversation &&
        turn.items.some((item) => item.tool === "offer_next_step_v0") && (
          <Suspense fallback={null}>
            <ChatSuggestions conversation={conversation} turn={turn} />
          </Suspense>
        )}
      {variant === "chat" &&
        conversation &&
        conversation.turns.at(-1)?.id === turn.id && (
          <Suspense fallback={null}>
            <ChatSuggestions
              conversation={conversation}
              turn={turn}
              kind="tip"
            />
          </Suspense>
        )}
    </LocalFileLinks.Provider>
  );
}
