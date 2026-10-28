import type { CSSProperties } from "react";
import { formatText, t } from "../../i18n";
import { TooltipGroup, WithTooltip } from "../../ui/Tooltip";
import type { WorkflowAgent } from "../../../shared/workflow-model";

export type AgentCellState =
  "done" | "running" | "stalled" | "error" | "stopped" | "pending" | "ghost";
type AgentState = Exclude<AgentCellState, "ghost" | "stalled">;

/**
 * The most cells drawn: one clipped row of 36, or, wrapping in a card, rows of
 * 35 up to 8 rows; more agents share the cells in proportion.
 */
export const MAX_AGENT_CELLS = 36;
export const WRAP_ROW_CELLS = 35;
export const WRAP_MAX_ROWS = 8;
const ORDER: AgentState[] = ["done", "running", "error", "stopped", "pending"];

/** A child agent's Codex status as a cell. */
export function agentCellState(status: string): AgentState | "stalled" {
  if (status === "completed" || status === "shutdown") return "done";
  if (status === "running") return "running";
  if (status === "stalled") return "stalled";
  if (status === "pendingInit") return "pending";
  if (status === "interrupted") return "stopped";
  return "error";
}

type Agent = Pick<WorkflowAgent, "status"> & { name?: string };

/** The agents counted by state (stalled ones are also running). */
function countStates(agents: Agent[]) {
  const counts = {
    done: 0,
    running: 0,
    stalled: 0,
    error: 0,
    stopped: 0,
    pending: 0,
  };
  for (const agent of agents) {
    const state = agentCellState(agent.status);
    if (state === "stalled") {
      counts.stalled++;
      counts.running++;
    } else counts[state]++;
  }
  return counts;
}

/**
 * The cells, grouped done, running, stalled, failed, stopped, queued, with
 * each agent's name while every agent has its own cell; past the limit each
 * state keeps a cell and the rest are shared by size (the original's `nke`).
 * A ghost follows when more agents are known to be coming.
 */
export function agentCellRecords(
  agents: Agent[],
  moreMayAppear = false,
  limit = MAX_AGENT_CELLS,
): { state: AgentCellState; name?: string }[] {
  const room = limit - (moreMayAppear ? 1 : 0);
  const counts = countStates(agents);
  const out: { state: AgentCellState; name?: string }[] = [];
  if (agents.length <= room) {
    const order: (AgentState | "stalled")[] = [
      "done",
      "running",
      "stalled",
      "error",
      "stopped",
      "pending",
    ];
    for (const state of order)
      for (const agent of agents)
        if (agentCellState(agent.status) === state)
          out.push({ state, name: agent.name });
  } else {
    const shares: Record<AgentState, number> = {
      done: 0,
      running: 0,
      error: 0,
      stopped: 0,
      pending: 0,
    };
    let used = 0;
    for (const state of ORDER)
      if (counts[state] > 0 && used < room) {
        shares[state] = 1;
        used++;
      }
    const left = room - used;
    if (left > 0) {
      const exact = ORDER.map(
        (state) => (counts[state] / agents.length) * left,
      );
      const whole = exact.map(Math.floor);
      let sum = whole.reduce((a, b) => a + b, 0);
      const order = exact
        .map((value, i) => ({ i, frac: value - whole[i] }))
        .sort((a, b) => b.frac - a.frac);
      for (let k = 0; k < order.length && sum < left; k++) {
        whole[order[k].i]++;
        sum++;
      }
      ORDER.forEach((state, i) => (shares[state] += whole[i]));
    }
    for (const state of ORDER)
      for (let i = 0; i < shares[state]; i++) out.push({ state });
  }
  if (moreMayAppear) out.push({ state: "ghost" });
  return out;
}

/** The cells' states alone. */
export function agentCells(
  agents: Agent[],
  moreMayAppear = false,
  limit = MAX_AGENT_CELLS,
) {
  return agentCellRecords(agents, moreMayAppear, limit).map(
    (cell) => cell.state,
  );
}

/** The grid's label (the original's `ike`). */
export function agentGridSummary(agents: Agent[], moreMayAppear = false) {
  if (!agents.length) return formatText("Waiting for agents to start");
  const c = countStates(agents);
  const total = agents.length;
  return c.stopped > 0
    ? formatText(
        total === 1
          ? "{done} of {total} agent done, {stopped} stopped, {error} failed"
          : "{done} of {total} agents done, {stopped} stopped, {error} failed",
        { done: c.done, total, stopped: c.stopped, error: c.error },
      )
    : formatText(
        "{done} of {total} agents done, {running} running, {stalled} stalled, {error} failed",
        {
          done: c.done,
          total,
          running: c.running - c.stalled,
          stalled: c.stalled,
          error: c.error,
        },
      );
}

const stateLabels: Record<Exclude<AgentCellState, "ghost">, string> = {
  done: "Done",
  running: "Running",
  stalled: "Stalled",
  error: "Failed",
  stopped: "Stopped",
  pending: "Queued",
};

/**
 * A running cell's breathing, out of step with its neighbours: 2.4–3.8s
 * long and started at a different point of its cycle, both spread by the
 * golden ratio so no two neighbours match.
 */
function pulseStyle(index: number): CSSProperties {
  const duration = 2.4 + ((index * 0.7548776662) % 1) * 1.4;
  const phase = (index * 0.61803398875) % 1;
  return {
    animationDuration: `${duration.toFixed(2)}s`,
    animationDelay: `${(-phase * duration).toFixed(2)}s`,
  };
}

/**
 * One 6px square per child agent, 2px apart, coloured by its state (done,
 * running, stalled, failed, stopped, queued), running ones breathing out of
 * step, and a faintly pulsing outline after them while more agents may
 * appear. Each cell names its state and agent after 150ms of hover. In a
 * card (`wrap`) the cells wrap, up to 8 rows of 35; elsewhere one row of 36.
 */
export function AgentStatusGrid({
  agents,
  moreMayAppear = false,
  wrap = false,
}: {
  agents: Agent[];
  moreMayAppear?: boolean;
  wrap?: boolean;
}) {
  const cells = agentCellRecords(
    agents,
    moreMayAppear,
    wrap ? WRAP_ROW_CELLS * WRAP_MAX_ROWS : MAX_AGENT_CELLS,
  );
  if (!cells.length) return null;
  const summary = agentGridSummary(agents, moreMayAppear);
  return (
    <TooltipGroup delay={150}>
      <span
        className="agent-status-grid"
        data-wrap={wrap || undefined}
        role="img"
        aria-label={summary}
      >
        {cells.map((cell, index) => (
          <WithTooltip
            key={index}
            label={
              cell.state === "ghost"
                ? t("More agents may appear")
                : cell.name
                  ? `${t(stateLabels[cell.state])} · ${cell.name}`
                  : t(stateLabels[cell.state])
            }
          >
            {(tooltip) => (
              <i
                {...tooltip}
                data-state={cell.state}
                style={cell.state === "running" ? pulseStyle(index) : undefined}
              />
            )}
          </WithTooltip>
        ))}
      </span>
    </TooltipGroup>
  );
}
