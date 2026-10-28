import { UsersRound, Square, ChevronRight } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import type { Item } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";
import { ActivityMark } from "../TurnActivity";
import { AgentMessageAttribution } from "../agents/AgentMessageAttribution";
import { formatText, t } from "../../i18n";

/** Agent verbs. */
const labels: Record<string, string> = {
  spawnAgent: "Ran agent",
  sendInput: "Messaged an agent",
  resumeAgent: "Ran agent",
  wait: "Waited for agents",
  closeAgent: "Closed an agent",
};
function agentStates(
  value: unknown,
): Array<{ id: string; status: string; message?: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .slice(0, 32)
    .map(([id, state]) => {
      const row =
        state && typeof state === "object"
          ? (state as Record<string, unknown>)
          : {};
      return {
        id,
        status: typeof row.status === "string" ? row.status : "unknown",
        message: typeof row.message === "string" ? row.message : undefined,
      };
    });
}
export function CollaborationToolView({
  item,
  chat = false,
}: {
  item: Item;
  chat?: boolean;
}) {
  if (item.type === "subAgentActivity") {
    const label =
      item.kind === "started"
        ? "Agent started"
        : item.kind === "interacted"
          ? "Agent updated"
          : item.kind === "interrupted"
            ? "Agent stopped"
            : "Agent activity";
    return (
      <div className="agent-collab-event" role="status">
        <UsersRound size={14} />
        <span>{label}</span>
        {typeof item.agentPath === "string" && <small>{item.agentPath}</small>}
      </div>
    );
  }
  const running = itemIsRunning(item),
    failed = item.status === "failed" || item.lifecycleStatus === "failed";
  const stopped = item.lifecycleStatus === "interrupted";
  const title = labels[item.tool ?? ""] ?? "Agent collaboration";
  const agents = agentStates(item.agentsStates);
  const count = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.length
    : 0;
  return (
    <details
      className={`activity agent-collab-activity is-plain${failed ? " failed" : ""}`}
    >
      <summary>
        {running ? (
          <ActivityMark phase="tools" />
        ) : failed ? (
          <AppIcon name="WarningCircle" size={15} />
        ) : stopped ? (
          <Square size={13} />
        ) : (
          <UsersRound size={15} />
        )}
        <span className="agent-collab-title">
          {chat &&
          running &&
          ["spawnAgent", "resumeAgent", "sendInput"].includes(item.tool ?? "")
            ? t("Multitasking…")
            : title === "Ran agent"
              ? t(
                  running
                    ? "Running agent"
                    : failed
                      ? "Failed to run agent"
                      : "Ran agent",
                )
              : running
                ? title.replace(
                    /^(Started|Messaged|Resumed|Waited|Closed)/,
                    (matched) =>
                      ({
                        Started: "Starting",
                        Messaged: "Messaging",
                        Resumed: "Resuming",
                        Waited: "Waiting",
                        Closed: "Closing",
                      })[matched] ?? matched,
                  )
                : failed
                  ? `${title} · failed`
                  : title}
        </span>
        {count > 0 && (
          <small>
            {formatText(count === 1 ? "{count} agent" : "{count} agents", {
              count,
            })}
          </small>
        )}
        <ChevronRight size={13} />
      </summary>
      <div className="activity-body agent-collab-body">
        {typeof item.prompt === "string" && item.prompt && (
          <section>
            <strong>Instruction</strong>
            <pre>{item.prompt}</pre>
          </section>
        )}
        {agents.length > 0 && (
          <section>
            <strong>Agents</strong>
            {agents.map((agent) => (
              <div className="agent-collab-state" key={agent.id}>
                <span>{agent.id.slice(0, 12)}</span>
                <span>{agent.status}</span>
                {agent.message && (
                  <div>
                    <AgentMessageAttribution
                      item={{
                        id: agent.id,
                        type: "peerMessage",
                        origin: {
                          kind: "peer",
                          subagent: true,
                          handback: agent.status === "completed",
                          relayedAgent: { name: item.agentNames?.[agent.id] },
                        },
                      }}
                    />
                    <small>{agent.message}</small>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}
        {!item.prompt && !agents.length && (
          <p>{running ? "Waiting for agents…" : "No additional details"}</p>
        )}
      </div>
    </details>
  );
}
