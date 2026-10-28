import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Conversation, Item } from "../../shared/types";
import type { WorkflowThreadListener } from "../engine/engine-types";
import {
  WorkflowStopped,
  type AgentOptions,
  type WorkflowMeta,
} from "./script";
import { run } from "./extension-support";
import { agentEffort } from "./extension-support";
import { agentInstructions } from "./extension-support";
import { strictSchema } from "./extension-support";
import { parseJson } from "./extension-support";
import { actionOf } from "./extension-support";
import { toolTypes } from "./extension-support";
import type { WorkflowRuns } from "./extension";
import type { RunState } from "./extension";

/** The turn item the workflow card and Background tasks read. */
export function workflowItem(
  this: WorkflowRuns,
  id: string,
  callId: string,
  meta: WorkflowMeta,
  scriptPath: string,
): Item {
  return {
    id: `workflow-${callId || id}`,
    type: "collabAgentToolCall",
    tool: "workflow",
    status: "inProgress",
    workflowRunId: id,
    workflowName: meta.name,
    workflowDescription: meta.description,
    workflowPhases: meta.phases.map((phase) => phase.title),
    workflowScriptPath: scriptPath,
    workflowStartedAt: Date.now(),
    prompt: meta.description,
    receiverThreadIds: [],
    agentsStates: {},
    agentPhases: {},
    agentNames: {},
    agentModels: {},
    agentStartedAt: {},
    agentDurationMs: {},
    agentToolUses: {},
    agentCurrentAction: {},
  } as Item;
}

/** A replayed agent: listed as finished, with no thread behind it. */
export function recordCachedAgent(
  this: WorkflowRuns,
  state: RunState,
  agentId: string,
  label: string,
  phase: string,
) {
  const item = state.item;
  item.receiverThreadIds = [...(item.receiverThreadIds ?? []), agentId];
  item.agentNames = { ...item.agentNames, [agentId]: `${label} (cached)` };
  item.agentPhases = { ...item.agentPhases, [agentId]: phase };
  item.agentsStates = {
    ...item.agentsStates,
    [agentId]: {
      status: "completed",
      message: "Replayed from the earlier run",
    },
  };
  state.changed();
}

export async function runAgent(
  this: WorkflowRuns,
  state: RunState,
  conversation: Conversation,
  task: {
    prompt: string;
    opts: AgentOptions;
    label: string;
    phase: string;
    cwd?: string;
  },
): Promise<unknown> {
  const item = state.item;
  const messages = new Map<string, string>();
  let order: string[] = [];
  let toolUses = 0;
  let settle!: (status: string, error?: string) => void;
  const finished = new Promise<{ status: string; error?: string }>(
    (resolve) => {
      settle = (status, error) => resolve({ status, error });
    },
  );
  let threadId = "";
  const listener: WorkflowThreadListener = (method, params) => {
    if (method === "item/agentMessage/delta") {
      if (
        typeof params.itemId === "string" &&
        typeof params.delta === "string"
      ) {
        if (!messages.has(params.itemId)) order.push(params.itemId);
        messages.set(
          params.itemId,
          (messages.get(params.itemId) ?? "") + params.delta,
        );
      }
    } else if (method === "item/started") {
      const action = actionOf(params.item);
      if (action && threadId) {
        item.agentCurrentAction = {
          ...item.agentCurrentAction,
          [threadId]: action,
        };
        state.changed();
      }
    } else if (method === "item/completed") {
      const done = params.item;
      if (done?.type === "agentMessage" && typeof done.text === "string") {
        if (!messages.has(done.id)) order.push(done.id);
        messages.set(done.id, done.text);
      }
      if (toolTypes.has(done?.type) && threadId) {
        toolUses++;
        item.agentToolUses = { ...item.agentToolUses, [threadId]: toolUses };
        state.changed();
      }
    } else if (method === "turn/completed") {
      settle(params.turn?.status ?? "failed", params.turn?.error?.message);
    }
  };
  const startedAt = Date.now();
  let started: { threadId: string; turnId?: string; model: string };
  try {
    if (state.controller.signal.aborted) throw new WorkflowStopped();
    started = await this.options.engine.startWorkflowAgent(
      conversation.id,
      {
        prompt: task.prompt,
        model: task.opts.model,
        effort: agentEffort(task.opts.effort),
        outputSchema: task.opts.schema
          ? strictSchema(task.opts.schema)
          : undefined,
        cwd: task.cwd,
        instructions: agentInstructions(!!task.opts.schema),
      },
      listener,
    );
  } catch (error) {
    if (error instanceof WorkflowStopped) throw error;
    // An agent that could not start is a null, like one that died.
    const failedId = `${state.id}:failed:${crypto.randomBytes(3).toString("hex")}`;
    item.receiverThreadIds = [...(item.receiverThreadIds ?? []), failedId];
    item.agentNames = { ...item.agentNames, [failedId]: task.label };
    item.agentPhases = { ...item.agentPhases, [failedId]: task.phase };
    item.agentsStates = {
      ...item.agentsStates,
      [failedId]: {
        status: "errored",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    state.changed();
    return null;
  }
  threadId = started.threadId;
  state.running.set(threadId, started.turnId);
  item.receiverThreadIds = [...(item.receiverThreadIds ?? []), threadId];
  item.agentNames = { ...item.agentNames, [threadId]: task.label };
  item.agentPhases = { ...item.agentPhases, [threadId]: task.phase };
  item.agentModels = { ...item.agentModels, [threadId]: started.model };
  item.agentStartedAt = { ...item.agentStartedAt, [threadId]: startedAt };
  item.agentsStates = {
    ...item.agentsStates,
    [threadId]: { status: "running", message: null },
  };
  state.changed();
  // A stop that arrived while the thread was starting.
  if (state.controller.signal.aborted)
    void this.options.engine.interruptWorkflowAgent(threadId, started.turnId);
  const { status, error } = await finished;
  state.running.delete(threadId);
  this.options.engine.releaseWorkflowAgent(threadId);
  const text =
    order
      .map((key) => messages.get(key) ?? "")
      .filter(Boolean)
      .at(-1) ?? "";
  const ok = status === "completed" && !!text;
  item.agentDurationMs = {
    ...item.agentDurationMs,
    [threadId]: Date.now() - startedAt,
  };
  const { [threadId]: _done, ...actions } = item.agentCurrentAction ?? {};
  item.agentCurrentAction = actions;
  item.agentsStates = {
    ...item.agentsStates,
    [threadId]: {
      status: ok
        ? "completed"
        : status === "interrupted"
          ? "interrupted"
          : "errored",
      message: ok
        ? null
        : (error ?? (status === "completed" ? "No final message" : null)),
    },
  };
  state.changed();
  if (!ok) return null;
  return task.opts.schema ? parseJson(text) : text;
}

/** A detached worktree of the session's repository at HEAD. */
export async function makeWorktree(
  this: WorkflowRuns,
  cwd: string | undefined,
  dir: string,
  index: number,
) {
  // Only on the desktop: the web runner would run git on the person's repo
  // outside their sandbox (hooks, filters and fsmonitor run commands).
  if (!process.versions.electron) return undefined;
  if (!cwd || !fs.existsSync(cwd)) return undefined;
  try {
    const { stdout } = await run("git", [
      "-C",
      cwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    const top = stdout.trim();
    const target = path.join(dir, "worktrees", String(index));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await run("git", [
      "-C",
      top,
      "worktree",
      "add",
      "--detach",
      target,
      "HEAD",
    ]);
    // The same relative folder inside the worktree.
    return path.join(target, path.relative(top, cwd));
  } catch {
    return undefined;
  }
}

export async function dropWorktreeIfClean(
  this: WorkflowRuns,
  cwd: string | undefined,
  worktree: string,
) {
  if (!cwd) return;
  try {
    const { stdout } = await run("git", [
      "-C",
      worktree,
      "status",
      "--porcelain",
    ]);
    if (stdout.trim()) return; // changes stay for the parent to look at
    const { stdout: top } = await run("git", [
      "-C",
      worktree,
      "rev-parse",
      "--show-toplevel",
    ]);
    await run("git", ["-C", cwd, "worktree", "remove", "--force", top.trim()]);
  } catch {}
}
