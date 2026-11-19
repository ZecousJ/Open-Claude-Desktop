import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation, Item, Turn } from "../../shared/types";
import { supportsCodeUltracode } from "../../shared/code-session-settings";
import {
  instructionOrder,
  type EngineExtension,
  type EngineTurnContext,
} from "../engine/engine-extensions";
import type {
  WorkflowAgentRequest,
  WorkflowThreadListener,
} from "../engine/engine-types";
import {
  workflowToolDescription,
  workflowToolInput,
  workflowToolName,
} from "./tool-description";
import { workflowSettings } from "./extension-support";
import * as workflowHandle from "./workflow-handle";
import { installMethods } from "./install-methods";
import * as workflowAgents from "./workflow-agents";

export const workflowExtensionId = "workflows";

/** What the extension needs from the app. */
export interface WorkflowEngine {
  startWorkflowAgent(
    conversationId: string,
    request: WorkflowAgentRequest,
    listener: WorkflowThreadListener,
  ): Promise<{ threadId: string; turnId?: string; model: string }>;
  interruptWorkflowAgent(threadId: string, turnId?: string): Promise<void>;
  releaseWorkflowAgent(threadId: string): void;
  /** Asks the window a question of the app's own ("Run workflow?"). */
  requestAppApproval(
    conversationId: string,
    params: Record<string, unknown>,
  ): Promise<any>;
}
export interface WorkflowExtensionOptions {
  engine: WorkflowEngine;
  /** The profile folder (run records live under it). */
  root: () => string;
  /** The app's settings now (a thread keeps the tool after it is turned off). */
  settings: () => EngineTurnContext["settings"];
  modelEfforts?: (providerId: string, model: string) => readonly string[] | undefined;
  /** The administrator's policy now (workflows off, approval required). */
  policy?: () => {
    workflows?: boolean;
    workflowsDefaultOn?: boolean;
    workflowApprovalRequired?: boolean;
    planLabel?: string | null;
  };
}

export function ultracodeFor(ctx: EngineTurnContext, sessionAvailable = false) {
  const turn = ctx.conversation.turns.at(-1);
  const selected = turn?.status === "inProgress"
    ? turn.codeUltracode
    : ctx.conversation.codeUltracode;
  if (selected && sessionAvailable) return true;
  if (ctx.settings.codeEffort === "ultra") return true;
  const prompt = turn?.prompt ?? "";
  return (
    workflowSettings(ctx.settings).keywordTrigger &&
    /\bultracode\b/i.test(prompt)
  );
}

export interface AgentRecord {
  key: string;
  result: unknown;
}

export interface RunState {
  id: string;
  conversationId: string;
  turnId: string;
  item: Item;
  controller: AbortController;
  /** Running agents: thread → turn. */
  running: Map<string, string | undefined>;
  changed: () => void;
}

export class WorkflowRuns {
  runs = new Map<string, RunState>();
  constructor(readonly options: WorkflowExtensionOptions) {}

  private runsRoot() {
    return path.join(this.options.root(), "workflow-runs");
  }
  runDir(id: string, conversationId?: string) {
    if (!/^wf_[a-z0-9]{6,32}$/.test(id))
      throw new Error("Unknown workflow run.");
    const dir = path.join(this.runsRoot(), id);
    if (conversationId !== undefined) {
      let owner: unknown;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"))?.conversationId;
      } catch {}
      if (owner !== conversationId)
        throw new Error("This workflow run is not part of the conversation.");
    }
    return dir;
  }

  /** The script of a call: inline, a saved workflow, or a file. */
  scriptFor(
    args: Record<string, unknown>,
    conversation: Pick<Conversation, "id" | "cwd" | "environment">,
  ): { source: string; origin: string } {
    const { cwd } = conversation;
    const hosted = conversation.environment?.kind === "space";
    const homeWorkflows = hosted ? undefined : path.join(os.homedir(), ".claude", "workflows");
    if (typeof args.script === "string" && args.script.trim())
      return { source: args.script, origin: "inline" };
    if (typeof args.name === "string" && args.name.trim()) {
      const name = args.name.trim();
      if (!/^[\w.-]{1,80}$/.test(name))
        throw new Error("Unknown workflow name.");
      const places = [
        ...(cwd ? [{ file: path.join(cwd, ".claude", "workflows", `${name}.js`), root: cwd }] : []),
        ...(homeWorkflows ? [{ file: path.join(homeWorkflows, `${name}.js`), root: homeWorkflows }] : []),
      ];
      const found = places.find(({ file }) => fs.existsSync(file));
      if (!found)
        throw new Error(
          `No saved workflow named "${name}".`,
        );
      return {
        source: readInside(found.file, [found.root]),
        origin: found.file,
      };
    }
    if (typeof args.scriptPath === "string" && args.scriptPath.trim()) {
      const file = path.resolve(cwd ?? (hosted ? this.options.root() : os.homedir()), args.scriptPath.trim());
      const allowed = cwd ? [cwd] : [];
      const runs = this.runsRoot();
      const dir = path.dirname(file);
      if (hosted) {
        if (path.dirname(dir) === runs && path.basename(file) === "script.js")
          allowed.push(this.runDir(path.basename(dir), conversation.id));
      } else if (homeWorkflows) {
        allowed.push(runs, homeWorkflows);
      }
      return { source: readInside(file, allowed), origin: file };
    }
    throw new Error("Pass script, name or scriptPath.");
  }

  journal(id: string, conversationId?: string): AgentRecord[] {
    const dir = this.runDir(id, conversationId);
    try {
      return fs
        .readFileSync(path.join(dir, "journal.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /** Stops a running run: no new agents, running ones are interrupted. */
  async stop(runId: string) {
    const state = this.runs.get(runId);
    if (!state) return false;
    state.controller.abort();
    await Promise.all(
      [...state.running].map(([threadId, turnId]) =>
        this.options.engine.interruptWorkflowAgent(threadId, turnId),
      ),
    );
    return true;
  }
  /** Stops the runs of a turn that ended (Stop on the conversation). */
  stopTurn(conversationId: string, turnId: string) {
    for (const state of this.runs.values())
      if (state.conversationId === conversationId && state.turnId === turnId)
        void this.stop(state.id);
  }
  /** Each conversation's sandbox at its latest turn (bypass runs without asking). */
  readonly sandboxes = new Map<string, string>();
  running(runId: string) {
    return this.runs.has(runId);
  }
}

export interface WorkflowRuns {
  workflowItem: OmitThisParameter<typeof workflowAgents.workflowItem>;
  recordCachedAgent: OmitThisParameter<typeof workflowAgents.recordCachedAgent>;
  runAgent: OmitThisParameter<typeof workflowAgents.runAgent>;
  makeWorktree: OmitThisParameter<typeof workflowAgents.makeWorktree>;
  dropWorktreeIfClean: OmitThisParameter<
    typeof workflowAgents.dropWorktreeIfClean
  >;
}
installMethods(WorkflowRuns.prototype, workflowAgents);

export interface WorkflowRuns {
  handle: OmitThisParameter<typeof workflowHandle.handle>;
}
installMethods(WorkflowRuns.prototype, workflowHandle);

/**
 * Reads a script that must lie inside one of `roots` once links are
 * followed: the web runner reads it outside the person's sandbox, so a link
 * in their folder must not reach the host's files.
 */
function readInside(file: string, roots: string[]) {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    throw new Error(`Cannot read ${file}.`);
  }
  const inside = roots.some((root) => {
    let base: string;
    try {
      base = fs.realpathSync(root);
    } catch {
      return false;
    }
    const rel = path.relative(base, real);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!inside || !fs.statSync(real).isFile())
    throw new Error(
      "scriptPath must be a run's script, a file in the project, or ~/.claude/workflows.",
    );
  return fs.readFileSync(real, "utf8");
}

/** The extension: the tool in Code sessions, and Ultracode for the turn. */
export function createWorkflowExtension(
  options: WorkflowExtensionOptions,
): EngineExtension & { runs: WorkflowRuns } {
  const runs = new WorkflowRuns(options);
  const offered = (ctx: EngineTurnContext) =>
    ctx.mode === "code" &&
    workflowSettings(ctx.settings, ctx.policy).enabled &&
    options.policy?.().workflows !== false;
  return {
    id: workflowExtensionId,
    order: instructionOrder.feature,
    runs,
    dynamicTools(ctx) {
      if (ctx.mode !== "code") return;
      return [
        {
          type: "function",
          name: workflowToolName,
          description: workflowToolDescription(workflowSettings(ctx.settings).size),
          inputSchema: workflowToolInput,
        },
      ];
    },
    turnContext(ctx) {
      runs.sandboxes.set(ctx.conversation.id, ctx.sandbox);
      if (ctx.mode !== "code") return;
      if (!offered(ctx)) return {
        ultracode: "Dynamic workflows are unavailable for this turn. Do the work directly.",
      };
      const supported = supportsCodeUltracode(options.modelEfforts?.(ctx.provider.id, ctx.model));
      return {
        ultracode: ultracodeFor(ctx, supported)
          ? "Ultracode is ON for this turn: the user opted into multi-agent orchestration. For substantive work, author and run a workflow with the Workflow tool (one per phase when it helps: understand → design → implement → review), and verify findings adversarially before you rely on them. Answer conversational messages and trivial edits directly."
          : "Ultracode is off for this turn. Instructions from earlier turns to run workflows by default do not apply. Run a workflow only if the user asks for one in this turn; the Ultracode keyword alone does not opt in.",
      };
    },
    async handleDynamicTool(call) {
      if (call.namespace || call.tool !== workflowToolName) return;
      if (call.conversation.mode !== "code")
        throw new Error("Workflows run in Code sessions.");
      return runs.handle(call);
    },
    onTurnCompleted(conversation: Conversation, turn: Turn) {
      if (turn.status === "interrupted" || turn.status === "failed")
        runs.stopTurn(conversation.id, turn.id);
    },
  };
}
