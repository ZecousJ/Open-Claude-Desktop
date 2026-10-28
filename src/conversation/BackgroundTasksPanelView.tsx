import { BackgroundPanelResize } from "./BackgroundPanelResize";
import { t, formatText } from "../i18n";
import { BackgroundGlyph } from "./background-glyphs";
import { Minimize2, Maximize2, X } from "../ui/glyphs";
import { SessionLoopTask } from "../transcript/tools/SessionLoopTask";
import {
  commandItem,
  elapsedLabel,
  FinishedTerminal,
} from "./BackgroundTasksPanel";
import { WithTooltip } from "../ui/Tooltip";
import { AppIcon } from "../ui/app-icon";
import type { WorkflowSummary } from "../../shared/workflow-model";
import type { Conversation, BackgroundTerminalInfo } from "../../shared/types";
import type { FinishedBackgroundTerminal } from "../../shared/panels-api";
import type { DevServerState } from "../../shared/browser";
import type { RunningCommandTask } from "./running-command-tasks";
import type { SessionLoop } from "../../shared/session-loops";

/** What backgroundTasksPanelView needs from BackgroundTasksPanel.tsx. */
export interface BackgroundTasksPanelViewKit {
  active: WorkflowSummary[];
  clearFinished: () => undefined;
  conversations: Conversation[];
  expanded: boolean;
  finishedCount: number;
  finishedTerminals: FinishedBackgroundTerminal[];
  firstSeen: React.RefObject<Map<string, number>>;
  foreground: RunningCommandTask[];
  listScrollRef: React.RefObject<HTMLDivElement | null>;
  listScrollTop: React.RefObject<number>;
  now: number;
  onClearFinished: ((ids: string[]) => Promise<void>) | undefined;
  onClose: () => void;
  onError: (error: unknown) => void;
  onStopCommand: ((conversationId: string) => Promise<void>) | undefined;
  onStopTerminal:
    | ((conversationId: string, processId: string) => Promise<boolean>)
    | undefined;
  panelRef: React.RefObject<HTMLElement | null>;
  past: WorkflowSummary[];
  persist: (value: number) => void;
  previews: { servers: DevServerState[]; refresh: () => void };
  renderTask: (task: WorkflowSummary) => React.JSX.Element;
  resize: (value: number) => void;
  sessionLoops: {
    loops: SessionLoop[];
    stopping: Set<string>;
    stop: (loop: SessionLoop) => Promise<void>;
  };
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setShowFinished: React.Dispatch<React.SetStateAction<boolean>>;
  showFinished: boolean;
  stopServer: (server: DevServerState) => void;
  stopTerminal: (item: BackgroundTerminalInfo) => void;
  stopping: Set<string>;
  stoppingServers: Set<string>;
  terminals: BackgroundTerminalInfo[];
  width: number | undefined;
}

export function backgroundTasksPanelView(kit: BackgroundTasksPanelViewKit) {
  const {
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
  } = kit;
  const backgroundTasksPanelViewView = (
    <aside
      ref={panelRef}
      className={`work-panel background-tasks-panel${expanded ? " expanded" : ""}`}
      aria-label="Background tasks"
    >
      {!expanded && (
        <BackgroundPanelResize
          panel={panelRef}
          width={width}
          onResize={resize}
          persist={persist}
        />
      )}
      <header>
        <strong>Background tasks</strong>
        <div>
          {/* Clear finished tasks. */}
          <button
            className="background-clear"
            aria-label={t("Clear finished tasks")}
            title={t("Clear finished tasks")}
            aria-disabled={!finishedCount || !onClearFinished || undefined}
            onClick={() => {
              if (finishedCount && onClearFinished) clearFinished();
            }}
          >
            <BackgroundGlyph name="Trash" />
          </button>
          <button
            aria-label={
              expanded ? "Restore background tasks" : "Expand background tasks"
            }
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button aria-label="Close background tasks" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div
        className="background-tasks-scroll"
        ref={listScrollRef}
        onScroll={(event) => {
          listScrollTop.current = event.currentTarget.scrollTop;
        }}
      >
        {(active.length > 0 ||
          terminals.length > 0 ||
          foreground.length > 0 ||
          sessionLoops.loops.length > 0 ||
          previews.servers.length > 0) && (
          <section>
            <h3>Running</h3>
            {sessionLoops.loops.map((loop) => (
              <SessionLoopTask
                key={loop.id}
                loop={loop}
                now={now}
                stopping={sessionLoops.stopping.has(loop.id)}
                onStop={(value) => void sessionLoops.stop(value)}
              />
            ))}
            {active.map(renderTask)}
            {terminals.map((item) => {
              const started = commandItem(
                conversations,
                item.conversationId,
                item.itemId,
              )?.startedAt;
              const since =
                typeof started === "number"
                  ? started
                  : (firstSeen.current.get(item.processId) ?? now);
              const own = commandItem(
                conversations,
                item.conversationId,
                item.itemId,
              );
              // The row is named by what the command does, as the model said it.
              const title =
                typeof own?.description === "string" && own.description.trim()
                  ? own.description
                  : item.command;
              return (
                <article
                  className="background-terminal-task"
                  key={`${item.conversationId}:${item.processId}`}
                >
                  <div>
                    <strong title={item.command}>{title}</strong>
                    <button
                      className="background-stop"
                      aria-label={
                        stopping.has(item.processId)
                          ? t("Stopping…")
                          : t("Stop this task")
                      }
                      aria-busy={stopping.has(item.processId) || undefined}
                      disabled={!onStopTerminal || stopping.has(item.processId)}
                      onClick={() => stopTerminal(item)}
                    >
                      <BackgroundGlyph name="Stop" />
                    </button>
                  </div>
                  <small title={item.cwd || "Working folder"}>
                    <span>Bash</span>
                    <span className="background-terminal-elapsed">
                      {stopping.has(item.processId)
                        ? "Stopping…"
                        : elapsedLabel(now - since)}
                    </span>
                  </small>
                </article>
              );
            })}
            {previews.servers.map((server) => (
              <article
                className="background-terminal-task"
                key={`server:${server.name}`}
              >
                <div>
                  <strong title={server.command}>
                    {formatText("Preview server: {name}", {
                      name: server.name,
                    })}
                  </strong>
                  <button
                    className="background-stop"
                    aria-label={
                      stoppingServers.has(server.name)
                        ? t("Stopping server…")
                        : t("Stop this server")
                    }
                    aria-busy={stoppingServers.has(server.name) || undefined}
                    disabled={stoppingServers.has(server.name)}
                    onClick={() => stopServer(server)}
                  >
                    <BackgroundGlyph name="Stop" />
                  </button>
                </div>
                <small title={server.url ?? server.command}>
                  <span>
                    {server.port ? `:${server.port}` : (server.url ?? "")}
                  </span>
                  <span className="background-terminal-elapsed">
                    {stoppingServers.has(server.name)
                      ? t("Stopping…")
                      : server.startedAt
                        ? elapsedLabel(now - server.startedAt)
                        : ""}
                  </span>
                </small>
              </article>
            ))}
            {foreground.map((item) => (
              <article
                className="background-terminal-task"
                key={`${item.conversationId}:${item.itemId}`}
              >
                <div>
                  <strong>{item.command}</strong>
                  <WithTooltip label="Stop the current Agent turn">
                    {(tooltip) => (
                      <button
                        {...tooltip}
                        className="background-stop"
                        aria-label={`Stop running command ${item.command}`}
                        disabled={!onStopCommand}
                        onClick={() =>
                          void onStopCommand?.(item.conversationId).catch(
                            onError,
                          )
                        }
                      >
                        <BackgroundGlyph name="Stop" />
                      </button>
                    )}
                  </WithTooltip>
                </div>
                <small title={item.cwd || "Working folder"}>
                  Bash · Running command
                </small>
              </article>
            ))}
          </section>
        )}
        {finishedCount > 0 && (
          <section className="background-finished">
            <h3 className="background-finished-heading">
              <button
                aria-expanded={showFinished}
                data-open={showFinished || undefined}
                onClick={() => setShowFinished(!showFinished)}
              >
                <span>{t("Finished")}</span>
                <span className="background-finished-count">
                  {finishedCount}
                </span>
                <BackgroundGlyph
                  name="CaretRight"
                  className="background-finished-caret"
                />
              </button>
            </h3>
            {showFinished && (
              <>
                {finishedTerminals.map((task) => (
                  <FinishedTerminal
                    key={task.id}
                    task={task}
                    item={commandItem(
                      conversations,
                      task.conversationId,
                      task.itemId,
                    )}
                  />
                ))}
                {past.map(renderTask)}
              </>
            )}
          </section>
        )}
        {!active.length &&
          !finishedCount &&
          !terminals.length &&
          !sessionLoops.loops.length &&
          !previews.servers.length &&
          !foreground.length && (
            // The original's empty state: an agents glyph over one line.
            <div className="panel-empty">
              <AppIcon name="AgentsSimple" />
              <p>Background tasks appear here</p>
            </div>
          )}
      </div>
    </aside>
  );
  return backgroundTasksPanelViewView;
}
