import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "../ui/glyphs";
import type {
  AgentTranscript,
  BackgroundTerminalInfo,
  Conversation,
  Item,
} from "../../shared/types";
import type { FinishedBackgroundTerminal } from "../../shared/panels-api";
import { workflowsIn, type WorkflowSummary } from "../../shared/workflow-model";
import { WorkflowTask } from "../transcript/workflow/WorkflowTask";
import {
  useNativeBackgroundTerminals,
  useWorkflowRefresh,
} from "./useBackgroundTaskPolling";
import { SingleAgentTask } from "../transcript/agents/SingleAgentTask";
import { runningCommandTasks } from "./running-command-tasks";
import { useBackgroundPanelWidth, useRailWidth } from "./BackgroundPanelResize";
import { AgentTranscriptPanel } from "../transcript/agents/AgentTranscriptPanel";
import { usePaneExpandToggle } from "../app/pane-expand";
import { api } from "../desktop-api";
import type { DevServerState } from "../../shared/browser";
import { useSessionLoops } from "../transcript/tools/SessionLoopTask";
import { backgroundTasksPanelView } from "./BackgroundTasksPanelView";

/**
 * The session's running preview servers (the Browser's dev servers), read
 * when the panel opens and every few seconds while it shows.
 */
function usePreviewServers(conversationId: string | undefined) {
  const [servers, setServers] = useState<DevServerState[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!conversationId || !api.browserState) {
      setServers([]);
      return;
    }
    let live = true;
    void Promise.resolve(api.browserState(conversationId))
      .then(
        (state) =>
          live &&
          setServers(
            state?.devServersAvailable
              ? state.devServers.filter(
                  (server) =>
                    server.status === "running" || server.status === "starting",
                )
              : [],
          ),
      )
      .catch(() => live && setServers([]));
    const timer = window.setTimeout(() => setTick((n) => n + 1), 5000);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [conversationId, tick]);
  return { servers, refresh: () => setTick((n) => n + 1) };
}

/** A running task's age as the original panel counts it: "12s", "3m 03s", "1h 02m". */
export function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The command's own item in the conversation, for its start time and output. */
export function commandItem(
  conversations: Conversation[],
  conversationId: string,
  itemId: string,
): Item | undefined {
  if (!itemId) return;
  return conversations
    .find((conversation) => conversation.id === conversationId)
    ?.turns.flatMap((turn) => turn.items)
    .find((item) => item.id === itemId);
}

/**
 * What the command printed, as its item has it, with the exit code when Codex
 * reported one; empty when unknown.
 */
function finishedOutput(item: Item | undefined, stopped = false) {
  // A stopped command that printed nothing reads "[killed]".
  if (!item) return stopped ? "\n[killed]" : "";
  const output =
    typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput.replace(/\s+$/, "")
      : "";
  const exit =
    typeof item.exitCode === "number"
      ? `[exited with code ${item.exitCode}]`
      : "";
  const marker = exit || (stopped ? "[killed]" : "");
  // R-0655/R-0793: a command that printed nothing still shows one empty
  // line above its "[exited with code 0]" / "[killed]" marker.
  if (!output) return marker ? `\n${marker}` : "";
  return marker ? `${output}\n\n${marker}` : output;
}

export function FinishedTerminal({
  task,
  item,
}: {
  task: FinishedBackgroundTerminal;
  item?: Item;
}) {
  const [open, setOpen] = useState(false);
  const output = finishedOutput(item, task.status === "stopped");
  // The card names what the command does, as the model said it.
  const title =
    typeof item?.description === "string" && item.description.trim()
      ? item.description
      : task.command;
  return (
    <article className="background-terminal-task is-finished">
      <button
        className="background-terminal-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <strong>{title}</strong>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <small title={task.cwd || "Working folder"}>
        <span>Bash</span>
        <span>{task.status === "stopped" ? "Stopped" : "Completed"}</span>
      </small>
      {open && (
        <>
          <pre className="background-terminal-command">
            <span>$ </span>
            {task.command}
          </pre>
          {output && <pre className="background-terminal-output">{output}</pre>}
        </>
      )}
    </article>
  );
}

/**
 * The Background tasks panel: the open conversation's running Workflow and
 * Agent tasks, background terminals and foreground command, and what finished.
 * Other conversations' tasks are not listed (G-51).
 */
export function BackgroundTasksPanel({
  conversations,
  activeConversationId,
  accountId,
  engineReady,
  onClose,
  onStop,
  onStopRun,
  onRefresh,
  onListTerminals,
  onStopTerminal,
  onStopCommand,
  onClearFinished,
  onReadAgent,
  dismissedFinished = [],
  onError,
}: {
  /** The conversation the panel belongs to (the open one). */
  conversations: Conversation[];
  activeConversationId?: string;
  accountId?: string;
  engineReady: boolean;
  onClose: () => void;
  onStop?: (conversationId: string, agentIds: string[]) => Promise<void>;
  onStopRun?: (conversationId: string, runId: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onListTerminals?: (conversationId: string) => Promise<{
    items: BackgroundTerminalInfo[];
    finished?: FinishedBackgroundTerminal[];
  }>;
  onStopTerminal?: (
    conversationId: string,
    processId: string,
  ) => Promise<boolean>;
  onStopCommand?: (conversationId: string) => Promise<void>;
  onClearFinished?: (ids: string[]) => Promise<void>;
  onReadAgent?: (
    conversationId: string,
    agentId: string,
  ) => Promise<AgentTranscript>;
  dismissedFinished?: string[];
  onError: (error: unknown) => void;
}) {
  const [expanded, setExpanded] = useState(false),
    [now, setNow] = useState(Date.now),
    [showFinished, setShowFinished] = useState(false),
    [ended, setEnded] = useState<FinishedBackgroundTerminal[]>([]),
    // Terminals whose Stop was sent and has not been answered yet.
    [stopping, setStopping] = useState<Set<string>>(new Set());
  const { width, setWidth, persist } = useBackgroundPanelWidth(accountId);
  // ⇧⌘\ expands or restores the card (src/app/pane-expand.ts).
  usePaneExpandToggle("background", () => setExpanded((value) => !value));
  const panelRef = useRef<HTMLElement>(null);
  useRailWidth(panelRef, expanded ? undefined : width);
  const resize = (value: number) => {
    setExpanded(false);
    setWidth(value);
  };
  const [selectedAgent, setSelectedAgent] = useState<{
    conversationId: string;
    agentId: string;
    title: string;
  }>();
  const listScrollTop = useRef(0),
    listScrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!selectedAgent && listScrollRef.current)
      listScrollRef.current.scrollTop = listScrollTop.current;
  }, [selectedAgent]);
  const workflows = workflowsIn(
    conversations.filter((conversation) => !conversation.archived),
  );
  const { terminals, setTerminals } = useNativeBackgroundTerminals(
    conversations,
    activeConversationId,
    engineReady,
    onListTerminals &&
      (async (conversationId) => {
        const listed = await onListTerminals(conversationId);
        setEnded(listed.finished ?? []);
        return listed.items;
      }),
    onError,
  );
  // When a terminal was first seen, for one whose item has no start time.
  const firstSeen = useRef(new Map<string, number>());
  for (const item of terminals)
    if (!firstSeen.current.has(item.processId))
      firstSeen.current.set(item.processId, Date.now());
  const activeIds = workflows
    .filter((task) => task.status === "running")
    .map((task) => task.id)
    .join("|");
  useWorkflowRefresh(activeIds, onRefresh, onError);
  const sessionLoops = useSessionLoops(
    conversations.find(
      (conversation) => conversation.id === activeConversationId,
    )?.mode === "code"
      ? activeConversationId
      : undefined,
    onError,
  );
  const ticking =
    Boolean(activeIds) || terminals.length > 0 || sessionLoops.loops.length > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const active = workflows.filter((w) => w.status === "running"),
    past = workflows.filter(
      (w) => w.status !== "running" && !dismissedFinished.includes(w.id),
    ),
    running = new Set(terminals.map((item) => item.processId)),
    finishedTerminals = ended
      .filter(
        (item) =>
          !running.has(item.processId) && !dismissedFinished.includes(item.id),
      )
      .sort((a, b) => b.finishedAt - a.finishedAt),
    finishedCount = past.length + finishedTerminals.length;
  const foreground = runningCommandTasks(conversations, terminals);
  const previews = usePreviewServers(activeConversationId);
  const [stoppingServers, setStoppingServers] = useState<Set<string>>(
    new Set(),
  );
  const stopServer = (server: DevServerState) => {
    if (!activeConversationId || !api.devServersStop) return;
    setStoppingServers((current) => new Set(current).add(server.name));
    void Promise.resolve(api.devServersStop(activeConversationId, server.name))
      .catch(onError)
      .finally(() => {
        setStoppingServers((current) => {
          const next = new Set(current);
          next.delete(server.name);
          return next;
        });
        previews.refresh();
      });
  };
  const clearFinished = () =>
    void onClearFinished?.([
      ...past.map((item) => item.id),
      ...finishedTerminals.map((item) => item.id),
    ]).catch(onError);
  if (selectedAgent && onReadAgent)
    return (
      <AgentTranscriptPanel
        key={`${selectedAgent.conversationId}:${selectedAgent.agentId}`}
        {...selectedAgent}
        accountId={accountId}
        onRead={onReadAgent}
        onBack={() => setSelectedAgent(undefined)}
        onClose={onClose}
        onError={onError}
      />
    );
  const renderTask = (task: WorkflowSummary) =>
    task.kind === "agent" && task.agents[0] ? (
      <SingleAgentTask
        key={task.id}
        task={task}
        now={now}
        onStop={onStop}
        onView={(conversationId, agentId, title) =>
          setSelectedAgent({ conversationId, agentId, title })
        }
        onError={onError}
      />
    ) : (
      <WorkflowTask
        key={task.id}
        workflow={task}
        now={now}
        onStop={onStop}
        onStopRun={onStopRun}
        onView={(conversationId, agentId, title) =>
          setSelectedAgent({ conversationId, agentId, title })
        }
        onError={onError}
      />
    );
  const stopTerminal = (item: BackgroundTerminalInfo) => {
    const release = () =>
      setStopping((current) => {
        const next = new Set(current);
        next.delete(item.processId);
        return next;
      });
    setStopping((current) => new Set(current).add(item.processId));
    void onStopTerminal?.(item.conversationId, item.processId)
      .then((stopped) => {
        release();
        if (!stopped) return;
        setTerminals((current) =>
          current.filter((value) => value.processId !== item.processId),
        );
        // Shown under Finished at once; the next listing brings the same record.
        setEnded((current) =>
          current.some((value) => value.processId === item.processId)
            ? current
            : [
                ...current,
                {
                  ...item,
                  id: `terminal:${item.conversationId}:${item.processId}`,
                  status: "stopped",
                  finishedAt: Date.now(),
                },
              ],
        );
      })
      .catch((error) => {
        release();
        onError(error);
      });
  };
  const backgroundTasksPanelViewView = backgroundTasksPanelView({
    active,
    clearFinished,
    conversations,
    expanded,
    finishedCount,
    finishedTerminals,
    firstSeen,
    foreground,
    listScrollRef,
    listScrollTop,
    now,
    onClearFinished,
    onClose,
    onError,
    onStopCommand,
    onStopTerminal,
    panelRef,
    past,
    persist,
    previews,
    renderTask,
    resize,
    sessionLoops,
    setExpanded,
    setShowFinished,
    showFinished,
    stopServer,
    stopTerminal,
    stopping,
    stoppingServers,
    terminals,
    width,
  });
  return backgroundTasksPanelViewView;
}
