import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordAgentsStopped } from "../../shared/agent-messages";
import {
  type DynamicToolCall,
  type DynamicToolResult,
} from "../engine/engine-extensions";
import {
  parseWorkflowScript,
  runWorkflowScript,
  WorkflowStopped,
  type AgentOptions,
} from "./script";
import { workflowConcurrency } from "./extension-support";
import { maxWorkflowAgents } from "./extension-support";
import { maxResultChars } from "./extension-support";
import { workflowApprovalServer } from "./extension-support";
import { workflowSettings } from "./extension-support";
import type { WorkflowRuns } from "./extension";
import type { AgentRecord, RunState } from "./extension";

export async function handle(
  this: WorkflowRuns,
  call: DynamicToolCall,
): Promise<DynamicToolResult> {
  const conversation = call.conversation;
  const turn = call.turn;
  if (!turn) throw new Error("The workflow has no turn to report to.");
  const args =
    call.arguments && typeof call.arguments === "object"
      ? (call.arguments as Record<string, unknown>)
      : {};
  const policy = this.options.policy?.() ?? {};
  if (policy.workflows === false)
    throw new Error(
      "Your organization has turned off dynamic workflows. Do the work yourself.",
    );
  if (
    !workflowSettings(this.options.settings(), { planLabel: null, ...policy })
      .enabled
  )
    throw new Error(
      "Dynamic workflows are turned off (Settings → Claudex Code). Do the work yourself.",
    );
  const { source, origin } = this.scriptFor(args, conversation.cwd);
  const { meta, body } = parseWorkflowScript(source);
  // Asked first, except in a session that bypasses permissions (unless
  // the organization requires approval each time).
  const managed = policy.workflowApprovalRequired === true;
  if (managed || this.sandboxes.get(conversation.id) !== "danger-full-access") {
    const answer = await this.options.engine.requestAppApproval(
      conversation.id,
      {
        serverName: workflowApprovalServer,
        mode: "form",
        message: `Allow Claudex to run a dynamic workflow ${meta.name}?`,
        workflowName: meta.name,
        workflowDescription: meta.description,
        ...(managed ? { workflowManaged: true } : {}),
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              enum: ["once"],
              enumNames: ["Run workflow"],
            },
          },
          required: ["decision"],
        },
      },
    );
    if (answer?.action !== "accept")
      return {
        contentItems: [
          {
            type: "inputText",
            text: `The user chose not to run the workflow "${meta.name}" (Not now). Do not run it again unless they ask; continue without it or ask how they want to proceed.`,
          },
        ],
        success: false,
      };
  }
  const resumeFrom =
    typeof args.resumeFromRunId === "string" && args.resumeFromRunId.trim()
      ? args.resumeFromRunId.trim()
      : undefined;
  const cached = resumeFrom ? this.journal(resumeFrom) : [];
  if (resumeFrom) this.runDir(resumeFrom); // validates the id

  const id = `wf_${crypto.randomBytes(8).toString("hex")}`;
  const dir = this.runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, "script.js");
  fs.writeFileSync(scriptPath, source);
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      id,
      conversationId: conversation.id,
      turnId: turn.id,
      meta,
      origin,
      args: args.args ?? null,
      resumeFrom: resumeFrom ?? null,
      startedAt: Date.now(),
    }),
  );

  const item = this.workflowItem(id, call.callId, meta, scriptPath);
  turn.items.push(item);
  call.changed();
  const state: RunState = {
    id,
    conversationId: conversation.id,
    turnId: turn.id,
    item,
    controller: new AbortController(),
    running: new Map(),
    changed: call.changed,
  };
  this.runs.set(id, state);

  const logs: string[] = [];
  let currentPhase: string | undefined = meta.phases[0]?.title;
  let agentCount = 0;
  let failed = 0;
  const occurrences = new Map<string, number>();
  const journalFile = path.join(dir, "journal.jsonl");

  const agent = async (prompt: string, opts: AgentOptions) => {
    const base = crypto
      .createHash("sha256")
      .update(JSON.stringify([prompt, opts]))
      .digest("hex");
    const nth = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, nth);
    const key = `${base}:${nth}`;
    const replay = cached.find((record) => record.key === key);
    const index = ++agentCount;
    const label = opts.label || `agent ${index}`;
    const phase = opts.phase || currentPhase || "Agents";
    if (replay) {
      this.recordCachedAgent(state, `${id}:cached:${index}`, label, phase);
      fs.appendFileSync(journalFile, JSON.stringify(replay) + "\n");
      return replay.result;
    }
    const worktree =
      opts.isolation === "worktree"
        ? await this.makeWorktree(conversation.cwd, dir, index)
        : undefined;
    try {
      const result = await this.runAgent(state, conversation, {
        prompt,
        opts,
        label,
        phase,
        cwd: worktree,
      });
      if (result === null) failed++;
      else
        fs.appendFileSync(
          journalFile,
          JSON.stringify({ key, result } satisfies AgentRecord) + "\n",
        );
      return result;
    } finally {
      if (worktree) await this.dropWorktreeIfClean(conversation.cwd, worktree);
    }
  };

  let outcome: { ok: true; value: unknown } | { ok: false; error: string };
  try {
    const value = await runWorkflowScript(
      body,
      {
        agent,
        log: (message) => {
          logs.push(message);
          item.workflowLog = [...logs.slice(-50)];
          state.changed();
        },
        phase: (title) => {
          currentPhase = title;
        },
      },
      {
        args: args.args,
        concurrency: workflowConcurrency,
        maxAgents: maxWorkflowAgents,
        signal: state.controller.signal,
      },
    );
    outcome = { ok: true, value };
  } catch (error) {
    outcome = {
      ok: false,
      error:
        error instanceof WorkflowStopped
          ? "The workflow was stopped."
          : // The script's own errors come from its context (not this realm's Error).
            typeof (error as { message?: unknown })?.message === "string"
            ? (error as { message: string }).message
            : String(error),
    };
  } finally {
    this.runs.delete(id);
  }
  const stopped = state.controller.signal.aborted;
  item.status = stopped ? "interrupted" : outcome.ok ? "completed" : "failed";
  item.workflowStatus = item.status;
  item.workflowEndedAt = Date.now();
  if (stopped && agentCount > 0) recordAgentsStopped(conversation);
  if (!outcome.ok) item.workflowError = outcome.error;
  state.changed();
  const resultText = outcome.ok
    ? (JSON.stringify(outcome.value ?? null, null, 1) ?? "null")
    : "";
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ ...outcome, logs, agents: agentCount, failed }),
  );
  const summary = [
    outcome.ok
      ? `Workflow "${meta.name}" finished (run ${id}): ${agentCount} agent${agentCount === 1 ? "" : "s"}${failed ? `, ${failed} failed or skipped (null)` : ""}.`
      : stopped
        ? `Workflow "${meta.name}" was stopped (run ${id}) after ${agentCount} agents.`
        : `Workflow "${meta.name}" failed (run ${id}) after ${agentCount} agents: ${outcome.error}`,
    logs.length ? `Log:\n${logs.slice(-20).join("\n")}` : "",
    outcome.ok
      ? `Result:\n${resultText.length > maxResultChars ? `${resultText.slice(0, maxResultChars)}\n… (${resultText.length - maxResultChars} more characters in ${path.join(dir, "result.json")})` : resultText}`
      : "",
    `Script: ${scriptPath} (edit it and pass scriptPath to iterate; resumeFromRunId: "${id}" replays the agents that finished).`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    contentItems: [{ type: "inputText", text: summary }],
    success: outcome.ok,
  };
}
