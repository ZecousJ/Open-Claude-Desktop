import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Conversation } from "../../shared/types";
import { railDragFrame, railDropBefore, type SlotBox } from "./rail-drag";
import { latestGeneratedFiles } from "../../shared/generated-files";
import { sessionPullRequests } from "../../shared/pull-request";
import { pullRequestKey, usePullRequests } from "../pr/pr-status-store";
import { preference } from "../../shared/settings-extras";
import { formatText, useT } from "../i18n";
import { api } from "../desktop-api";
import { useApp } from "../app/AppContext";
import { contextUsage } from "../composer/context-usage";
import { useModelCatalog } from "../composer/useComposerServices";
import { useBranchRow } from "../pr/useBranchRow";
import {
  editSessionCloudEnvironment,
  useCloudEnvironments,
} from "../composer/cloud-environments";
import { useWeeklyUsage } from "../policy/useWeeklyUsage";
import { tasksFromTurn } from "../../shared/workflow-model";
import { loopNextRun } from "../../shared/session-loops";
import {
  loopCountdown,
  useSessionLoops,
} from "../transcript/tools/SessionLoopTask";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import {
  railCardIds,
  railCardTitles,
  useRailLayout,
  type RailCardId,
} from "./rail-store";
import "./session-rail.css";
import { lazyPiece } from "../ui/lazy-piece";
import {
  useShowMore,
  compactHint,
  useSettingsRows,
  useConnectors,
  useSshHost,
  useServers,
} from "./rail-hooks";
import { type CardChrome } from "./RailParts";
import { fillRailCards } from "./rail-cards";
import type { RailTaskRow } from "./rail-cards-tools";

const EditGoalDialog = lazyPiece(() => import("./EditGoalDialog"));

/** Asks the composer to open one of its pickers (Composer listens). */
export const composerMenuEvent = "claudex:composer-menu";
export const openComposerMenu = (menu: "model" | "effort" | "permissions") =>
  window.dispatchEvent(new CustomEvent(composerMenuEvent, { detail: menu }));

/**
 * The Code session's rail of details beside the transcript, in the original's
 * order: Environment, Settings, Context, Usage, Connectors, Outputs, Changes
 * (the session's pull requests), Servers and Background tasks. Settings and
 * Usage start hidden (the cards menu shows them); Context, Usage, Connectors
 * and Background tasks start folded; a card with nothing to show is left out.
 */
export function SessionRail({
  conversation,
  raised = false,
}: {
  conversation: Conversation;
  /** Raised over the conversation as one card (no room for the column). */
  raised?: boolean;
}) {
  const t = useT();
  const app = useApp();
  const catalog = useModelCatalog();
  const { status, pr, ref } = useBranchRow(conversation);
  // The session's other pull requests (the original's rows and history).
  const earlierRefs = useMemo(
    () =>
      sessionPullRequests(conversation).filter(
        (other) => !ref || pullRequestKey(other) !== pullRequestKey(ref),
      ),
    [conversation.turns, ref?.url],
  );
  const earlierEntries = usePullRequests(earlierRefs, 10 * 60_000);
  const [now, setNow] = useState(Date.now);
  const layout = useRailLayout();
  const [menu, setMenu] = useState<MenuPosition>();
  const [dragging, setDragging] = useState<{
    id: RailCardId;
    dy: number;
    shifts: Partial<Record<RailCardId, number>>;
  }>();
  // Where a dropped card was drawn, to glide it into its new place.
  const dropped = useRef<{ id: RailCardId; top: number } | undefined>(
    undefined,
  );
  const scroll = useRef<HTMLDivElement>(null);
  const weekly = useWeeklyUsage().status;
  const connectors = useConnectors();
  const local =
    !conversation.environment || conversation.environment.kind === "local";
  const devServers = useServers(conversation.id, local);
  const settingsRows = useSettingsRows(conversation);
  const id = conversation.id;

  // Environment
  const cloudEnvironments = useCloudEnvironments(() => {});
  const environment = conversation.environment;
  const cloud = environment?.kind === "space";
  const ssh = environment?.kind === "ssh" ? environment : undefined;
  const sshHost = useSshHost(ssh?.hostId);
  // A cloud session names its cloud environment, the default one when it names
  // none.
  const cloudEnvironment = cloudEnvironments.environments.find(
    (entry) => entry.id === (conversation.cloudEnvironmentId ?? "default"),
  );
  const environmentLabel = cloud
    ? (cloudEnvironment?.name ?? t("Cloud"))
    : ssh
      ? (sshHost.label ?? "SSH")
      : t("This computer");
  const environmentHint = ssh ? "SSH" : undefined;
  const cwd = conversation.cwd;
  const folderName = cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const branch = status
    ? status.branch
    : (conversation.worktree?.branch ?? conversation.branch);
  const remoteAllowed = preference(app.snapshot.settings, "remoteControl");
  const remoteOn = remoteAllowed && !conversation.remoteControlOff;

  // Context
  const usage = contextUsage(conversation, catalog, conversation.model);
  const pct =
    usage.fraction === null
      ? null
      : Math.round(Math.min(1, usage.fraction) * 100);
  const modelItem = catalog?.items.find(
    (item) => item.id === conversation.model,
  );
  const hint = compactHint(
    usage.used,
    usage.window,
    modelItem?.autoCompactTokens,
  );
  const settled =
    conversation.turns.length > 0 &&
    conversation.turns.at(-1)?.status !== "inProgress";

  // Outputs: the files the session wrote, newest first.
  const outputs = [...latestGeneratedFiles(conversation.turns).values()]
    .filter((file) => file.state !== "deleted")
    .sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
  const outputRows = useShowMore(outputs, 5);

  // Background tasks: background terminals and running agents or workflows.
  const terminals = app.activeTerminals.filter(
    (terminal) => terminal.conversationId === id,
  );
  const tasks = conversation.turns.flatMap((turn) =>
    tasksFromTurn(turn, conversation),
  );
  const runningTasks = tasks.filter((task) => task.status === "running");
  const finished = tasks.filter((task) => task.status !== "running").length;
  // The session's scheduled prompts and loops come first, soonest first.
  const sessionLoops = useSessionLoops(
    conversation.mode === "code" ? id : undefined,
    app.report,
  );
  const running: RailTaskRow[] = [
    ...sessionLoops.loops
      .map((loop) => ({ loop, next: loopNextRun(loop, now) }))
      .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity))
      .map(({ loop, next }) => ({
        key: `loop:${loop.id}`,
        icon: "Clock" as const,
        title:
          loop.prompt ||
          t(loop.recurring ? "Recurring loop" : "Scheduled prompt"),
        hint: loop.cron,
        next:
          next === undefined
            ? undefined
            : formatText(t("Next <v>{countdown}</v>"), {
                countdown: loopCountdown(next - now),
              }).replace(/<\/?v>/g, ""),
        stopLabel: t(
          loop.recurring ? "Stop this loop" : "Stop this scheduled prompt",
        ),
        stop: () => sessionLoops.stop(loop),
      })),
    ...terminals.map((terminal) => ({
      key: terminal.processId,
      icon: "CommandLine" as const,
      title: terminal.command,
      elapsed: undefined as number | undefined,
      stop: () => api.stopBackgroundTerminal(id, terminal.processId),
    })),
    ...runningTasks
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((task) => ({
        key: task.id,
        icon: "AgentsSimple" as const,
        title: task.title,
        elapsed: (now - task.startedAt) / 1000,
        stop: () =>
          task.runId
            ? api
                .stopWorkflowRun(task.conversationId, task.runId)
                .then(() => undefined)
            : Promise.all(
                task.agents
                  .filter((agent) =>
                    ["running", "pendingInit"].includes(agent.status),
                  )
                  .map((agent) =>
                    api.stopWorkflowAgent(task.conversationId, agent.id),
                  ),
              ).then(() => undefined),
      })),
  ];
  const taskRows = useShowMore(running, 4);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [editingGoal, setEditingGoal] = useState(false);
  useEffect(() => {
    if (!runningTasks.length && !sessionLoops.loops.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningTasks.length, sessionLoops.loops.length]);

  const reconnect = connectors.filter(
    (server) =>
      server.state === "failed" || server.authStatus === "notLoggedIn",
  );

  const cards: Partial<Record<RailCardId, ReactNode>> = {};
  const chrome: CardChrome = {
    sessionId: id,
    onMenu: setMenu,
    onMove: (card, by) => layout.move(card, by),
    onDrag: (card, event) => {
      if (event.button !== 0 || !scroll.current) return;
      const startY = event.clientY;
      const slots = [
        ...scroll.current.querySelectorAll<HTMLElement>(".rail-card-slot"),
      ];
      const order = slots.map((node) => node.dataset.card as RailCardId);
      const from = order.indexOf(card);
      if (from < 0) return;
      const boxes: SlotBox[] = slots.map((node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, height: box.height };
      });
      let moved = false;
      let frame = { target: from, shifts: boxes.map(() => 0) };
      let dy = 0;
      const onMove = (move: PointerEvent) => {
        dy = move.clientY - startY;
        if (!moved && Math.abs(dy) < 6) return;
        moved = true;
        frame = railDragFrame(boxes, from, dy);
        setDragging({
          id: card,
          dy,
          shifts: Object.fromEntries(
            order.map((id, index) => [id, frame.shifts[index]]),
          ),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setDragging(undefined);
        if (!moved) return;
        const before = railDropBefore(order, from, frame.target);
        if (before === undefined) return;
        dropped.current = { id: card, top: boxes[from].top + dy };
        layout.place(card, before);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
  };
  // A dropped card glides from where it was let go (200ms ease, as the
  // live rail's drop animation); the others are already in place.
  useLayoutEffect(() => {
    const drop = dropped.current;
    dropped.current = undefined;
    const node = drop
      ? scroll.current?.querySelector<HTMLElement>(
          `.rail-card-slot[data-card="${drop.id}"]`,
        )
      : null;
    if (!drop || !node || typeof node.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const offset = drop.top - node.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) return;
    const glide = node.animate(
      [
        { translate: `0 ${offset}px`, zIndex: 1 },
        { translate: "0 0", zIndex: 1 },
      ],
      { duration: 200, easing: "ease" },
    );
    return () => glide.cancel();
  }, [layout.order]);
  fillRailCards({
    app,
    branch,
    cards,
    chrome,
    cloud,
    connectors,
    conversation,
    devServers,
    earlierEntries,
    earlierRefs,
    editCloudEnvironment: cloud
      ? () =>
          void editSessionCloudEnvironment(
            conversation.cloudEnvironmentId,
          ).catch(app.report)
      : undefined,
    environmentHint,
    environmentLabel,
    finished,
    folderName,
    hint,
    id,
    local,
    outputRows,
    outputs,
    pct,
    pr,
    reconnect,
    ref,
    remoteAllowed,
    remoteOn,
    running,
    setEditingGoal,
    setStopping,
    settingsRows,
    settled,
    sshHost,
    status,
    stopping,
    t,
    taskRows,
    usage,
    weekly,
  });

  const entries: MenuEntry[] = [
    ...railCardIds
      .filter((card) => card !== "environment")
      .map((card) => ({
        label: railCardTitles[card],
        checked: !layout.hidden.includes(card),
        keepOpen: true,
        onSelect: () => layout.toggle(card),
      })),
    { separator: true },
    { label: "Reset to defaults", onSelect: () => layout.reset() },
  ];

  return (
    <aside
      className={raised ? "session-rail raised" : "session-rail"}
      aria-label={t("Session details")}
    >
      <div className="session-rail-scroll" ref={scroll}>
        {layout.order
          .filter((card) => !layout.hidden.includes(card) && cards[card])
          .map((card) => (
            <div
              key={card}
              className="rail-card-slot"
              data-card={card}
              data-dragging={dragging?.id === card || undefined}
              style={
                !dragging
                  ? undefined
                  : dragging.id === card
                    ? { translate: `0 ${dragging.dy}px` }
                    : {
                        translate: `0 ${dragging.shifts[card] ?? 0}px`,
                        transition: "translate 250ms ease",
                      }
              }
            >
              {cards[card]}
            </div>
          ))}
      </div>
      {menu && (
        <Menu
          label={t("Session details")}
          entries={entries}
          position={menu}
          width={200}
          onClose={() => setMenu(undefined)}
        />
      )}
      {editingGoal && conversation.goal && (
        <Suspense fallback={null}>
          <EditGoalDialog
            initial={conversation.goal.condition}
            onClose={() => setEditingGoal(false)}
            onSave={(condition) => {
              setEditingGoal(false);
              void api.updateConversation(
                id,
                condition
                  ? {
                      goal: {
                        ...conversation.goal!,
                        condition,
                        setAt: Date.now(),
                      },
                    }
                  : { goal: null },
              );
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}
