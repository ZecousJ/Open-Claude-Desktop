import { RailCard, severity, RailRow, RailIcon } from "./RailParts";
import { formatText } from "../i18n";
import {
  UsageContributions,
  PullRequestRailRow,
  EarlierPullRequests,
} from "./RailPullRequests";
import { mcpStateLabels } from "../settings/tabs/desktop-labels";
import { latestPlan } from "../plan/PlanPanel";
import { PlanSteps } from "../plan/PlanSteps";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { openArtifact } from "../app/ArtifactHost";
import { pullRequestIsLive } from "../../shared/pull-request-status";
import { formatWorkflowTime } from "../../shared/workflow-model";
import type { AppController } from "../app/AppContext";
import type { CardChrome } from "./RailParts";
import type { McpServerState } from "../../shared/settings-desktop-api";
import type { Conversation, GeneratedFile } from "../../shared/types";
import type { DevServerState } from "../../shared/browser";
import type { PullRequestEntry } from "../pr/pr-status-store";
import type { PullRequestRef } from "../../shared/pull-request";
import type { GitHubPullRequest } from "../../shared/github-api";
import type { WeeklyUsageStatus } from "../../shared/usage-api";

/** A Background tasks row: a scheduled prompt or loop, a terminal, an agent. */
export interface RailTaskRow {
  key: string;
  icon: "Clock" | "CommandLine" | "AgentsSimple";
  title: string;
  /** Seconds running, for a task. */
  elapsed?: number;
  /** "Next 6m", for a scheduled prompt or loop. */
  next?: string;
  /** The schedule, shown on hover. */
  hint?: string;
  stopLabel?: string;
  stop: () => Promise<unknown>;
}

/** What fillRailToolCards needs from rail-cards.tsx. */
export interface FillRailToolCardsKit {
  app: AppController;
  cards: Partial<
    Record<
      | "goal"
      | "environment"
      | "settings"
      | "context"
      | "usage"
      | "connectors"
      | "progress"
      | "outputs"
      | "pullRequests"
      | "servers"
      | "backgroundTasks",
      React.ReactNode
    >
  >;
  chrome: CardChrome;
  connectors: McpServerState[];
  conversation: Conversation;
  devServers: DevServerState[];
  earlierEntries: PullRequestEntry[];
  earlierRefs: PullRequestRef[];
  finished: number;
  id: string;
  outputRows: { shown: GeneratedFile[]; toggle: React.JSX.Element | null };
  outputs: GeneratedFile[];
  pr: GitHubPullRequest | undefined;
  reconnect: McpServerState[];
  ref: PullRequestRef | undefined;
  running: RailTaskRow[];
  setStopping: React.Dispatch<React.SetStateAction<Set<string>>>;
  stopping: Set<string>;
  t: (text: string) => string;
  taskRows: {
    shown: RailTaskRow[];
    toggle: React.JSX.Element | null;
  };
  weekly: WeeklyUsageStatus | null;
}

export function fillRailToolCards(kit: FillRailToolCardsKit) {
  const {
    app,
    cards,
    chrome,
    connectors,
    conversation,
    devServers,
    earlierEntries,
    earlierRefs,
    finished,
    id,
    outputRows,
    outputs,
    pr,
    reconnect,
    ref,
    running,
    setStopping,
    stopping,
    t,
    taskRows,
    weekly,
  } = kit;
  if (weekly)
    cards.usage = (
      <RailCard
        chrome={chrome}
        id="usage"
        defaultOpen={false}
        summary={`${weekly.percent}%`}
      >
        <div className="rail-context-body">
          <div className="rail-context-row">
            <span className="rail-tabular">
              {formatText("{percent} used", { percent: `${weekly.percent}%` })}
            </span>
            <span className="rail-detail">
              {formatText("Plan usage resets {time}", {
                time: new Date(weekly.resetsAt).toLocaleString(undefined, {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </span>
          </div>
          <div className="rail-context-bar" aria-hidden="true">
            <div
              className="rail-context-fill"
              data-severity={severity(weekly.percent)}
              style={{ width: `${weekly.percent}%` }}
            />
          </div>
          <UsageContributions conversation={conversation} />
        </div>
      </RailCard>
    );

  if (connectors.length)
    cards.connectors = (
      <RailCard
        chrome={chrome}
        id="connectors"
        defaultOpen={false}
        summary={
          reconnect.length
            ? formatText("{count} to reconnect", { count: reconnect.length })
            : String(connectors.length)
        }
      >
        {connectors.map((server) => (
          <RailRow
            key={server.name}
            title={server.error}
            trailing={
              server.authStatus === "notLoggedIn" && server.url ? (
                <button
                  type="button"
                  className="rail-compact-button"
                  onClick={() =>
                    void window.desktop
                      .connectConnector(server.name)
                      .catch(app.report)
                  }
                >
                  {t("Connect")}
                </button>
              ) : (
                <span
                  className="rail-detail rail-trailing"
                  data-state={server.state}
                >
                  {server.authStatus === "notLoggedIn"
                    ? t("Needs sign-in")
                    : t(mcpStateLabels[server.state])}
                </span>
              )
            }
          >
            {server.name}
          </RailRow>
        ))}
      </RailCard>
    );

  // Progress: the session's task list, "{done} of {total}", only while it has
  // one.
  const plan = latestPlan(conversation) ?? [];
  if (plan.length)
    cards.progress = (
      <RailCard
        chrome={chrome}
        id="progress"
        defaultOpen
        summary={formatText("{done} of {total}", {
          done: plan.filter((step) => step.status === "completed").length,
          total: plan.length,
        })}
      >
        <div className="rail-progress">
          <PlanSteps
            conversationId={conversation.id}
            plan={plan}
            live={conversation.turns.at(-1)?.status === "inProgress"}
          />
        </div>
      </RailCard>
    );

  if (outputs.length)
    cards.outputs = (
      <RailCard
        chrome={chrome}
        id="outputs"
        defaultOpen
        summary={String(outputs.length)}
      >
        {outputRows.shown.map((file) => {
          const artifact = generatedArtifact(file);
          return (
            <RailRow
              key={file.path}
              icon="File"
              title={file.path}
              onClick={
                artifact
                  ? () => openArtifact(app, { ...artifact, conversationId: id })
                  : undefined
              }
            >
              {file.name}
            </RailRow>
          );
        })}
        {outputRows.toggle}
      </RailCard>
    );

  // Changes: the session's open pull requests as rows, the merged and closed
  // ones under "{count} earlier pull requests" (they are the rows when none is
  // open).
  const earlier = earlierRefs.map((ref, index) => ({
    ref,
    pr: earlierEntries[index]?.pr,
  }));
  const openPrs = earlier.filter(
    (entry) => !entry.pr || pullRequestIsLive(entry.pr),
  );
  const settledPrs = earlier.filter(
    (entry) => entry.pr && !pullRequestIsLive(entry.pr),
  );
  const prRows = [...(pr ? [{ ref: ref!, pr }] : []), ...openPrs];
  const shownRows = prRows.length ? prRows : settledPrs;
  const history = prRows.length ? settledPrs : [];
  const prCount = (pr ? 1 : 0) + earlier.length;
  if (prCount) {
    cards.pullRequests = (
      <RailCard
        chrome={chrome}
        id="pullRequests"
        defaultOpen
        summary={
          prCount === 1
            ? t("1 pull request")
            : formatText("{count} pull requests", { count: prCount })
        }
      >
        {shownRows.map((entry) => (
          <PullRequestRailRow key={entry.ref.url} entry={entry} />
        ))}
        {history.length > 0 && <EarlierPullRequests entries={history} />}
      </RailCard>
    );
  }

  const shownServers = devServers.filter(
    (server) => server.status !== "stopped",
  );
  // A server row: the Cache glyph, its name, then "localhost:{port}" once it
  // runs, "Starting…" until then or "Failed to start" in red, and a Stop
  // button; the summary counts the running ones.
  if (shownServers.length)
    cards.servers = (
      <RailCard
        chrome={chrome}
        id="servers"
        defaultOpen
        summary={formatText("{count} running", {
          count: shownServers.filter((server) => server.status === "running")
            .length,
        })}
      >
        {shownServers.map((server) => {
          const key = `server:${server.name}`;
          const failed =
            server.status === "failed" || server.status === "crashed";
          const address = server.port ? `localhost:${server.port}` : undefined;
          return (
            <RailRow
              key={server.name}
              icon="Cache"
              title={server.url ?? server.command}
              onClick={() => app.setPanel("browser")}
              trailing={
                <span className="rail-task-end">
                  {server.status === "running" ? (
                    address &&
                    address !== server.name && (
                      <span className="rail-detail rail-tabular">
                        {address}
                      </span>
                    )
                  ) : (
                    <span
                      className="rail-detail"
                      data-state={failed ? "failed" : undefined}
                    >
                      {t(failed ? "Failed to start" : "Starting…")}
                    </span>
                  )}
                  <button
                    type="button"
                    className="rail-stop"
                    aria-label={t(
                      stopping.has(key)
                        ? "Stopping server…"
                        : "Stop this server",
                    )}
                    title={t(
                      stopping.has(key)
                        ? "Stopping server…"
                        : "Stop this server",
                    )}
                    disabled={stopping.has(key)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setStopping((current) => new Set(current).add(key));
                      void window.desktop
                        .devServersStop(id, server.name)
                        .catch(app.report)
                        .finally(() =>
                          setStopping((current) => {
                            const next = new Set(current);
                            next.delete(key);
                            return next;
                          }),
                        );
                    }}
                  >
                    <RailIcon name="Stop" />
                  </button>
                </span>
              }
            >
              {server.name}
            </RailRow>
          );
        })}
      </RailCard>
    );

  if (running.length || finished)
    cards.backgroundTasks = (
      <RailCard
        chrome={chrome}
        id="backgroundTasks"
        defaultOpen
        summary={
          running.length
            ? formatText("{count} running", { count: running.length })
            : undefined
        }
      >
        {taskRows.shown.map((task) => (
          <RailRow
            key={task.key}
            icon={task.icon}
            title={task.hint}
            onClick={() => app.setPanel("background")}
            trailing={
              <span className="rail-task-end">
                {(task.next ?? task.elapsed) !== undefined && (
                  <span className="rail-detail rail-tabular">
                    {task.next ?? formatWorkflowTime(task.elapsed!)}
                  </span>
                )}
                <button
                  type="button"
                  className="rail-stop"
                  aria-label={task.stopLabel ?? t("Stop this task")}
                  title={
                    stopping.has(task.key)
                      ? t("Stopping…")
                      : (task.stopLabel ?? t("Stop this task"))
                  }
                  disabled={stopping.has(task.key)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setStopping((current) => new Set(current).add(task.key));
                    void task.stop().catch(app.report);
                  }}
                >
                  <RailIcon name="Stop" />
                </button>
              </span>
            }
          >
            {task.title}
          </RailRow>
        ))}
        {taskRows.toggle}
        {finished > 0 && (
          <RailRow
            icon="AgentsSimple"
            onClick={() => app.setPanel("background")}
          >
            {formatText("{count} finished", { count: finished })}
          </RailRow>
        )}
      </RailCard>
    );
}
