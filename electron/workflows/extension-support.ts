import { dynamicWorkflowsEnabled } from "../../shared/code-session-settings";
import { type EngineTurnContext } from "../engine/engine-extensions";
import { workflowSizes, type WorkflowSize } from "./tool-description";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

/** Agents running at once (the official cap: min(16, CPUs − 2)). */
export const workflowConcurrency = Math.max(
  2,
  Math.min(16, os.cpus().length - 2),
);

export const maxWorkflowAgents = 1000;

/** Most characters of a result given back to the model. */
export const maxResultChars = 60_000;

export const run = promisify(execFile);

/** A script's effort as Codex takes it ('max' is the top regular stop). */
export function agentEffort(effort: string | undefined) {
  if (effort === "max" || effort === "ultra") return "xhigh";
  return effort &&
    ["minimal", "low", "medium", "high", "xhigh"].includes(effort)
    ? effort
    : undefined;
}

export const agentInstructions = (schema: boolean) =>
  [
    "You are one agent of a workflow that another agent is running. You do not see its conversation: everything you need is in this message.",
    "Do the task completely, then end with a final message that IS your return value: give the data asked for, not a report written for a person, and no closing questions.",
    schema
      ? "Your final message must be JSON that follows the given schema, and nothing else."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

/** The Workflow tool's "Run workflow?" (src/approval/WorkflowApprovalCard.tsx). */
export const workflowApprovalServer = "claudex_workflow";

/** The workflow settings (Settings → Claudex Code), with their defaults. */
export function workflowSettings(
  settings: EngineTurnContext["settings"],
  policy?: Pick<
    EngineTurnContext["policy"],
    "workflows" | "workflowsDefaultOn" | "planLabel"
  >,
) {
  const own = settings.workflows ?? {};
  const size: WorkflowSize = workflowSizes.includes(own.size as WorkflowSize)
    ? (own.size as WorkflowSize)
    : "medium";
  return {
    enabled: dynamicWorkflowsEnabled(settings, policy),
    size,
    keywordTrigger: own.keywordTrigger !== false,
  };
}

/**
 * OpenAI structured outputs want closed objects with every property listed
 * as required: optional properties become nullable instead.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema))
    s[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, strictSchema(v)]),
          )
        : strictSchema(value);
  if (s.type === "object" || s.properties) {
    const props = (s.properties ?? {}) as Record<string, any>;
    const required = new Set(
      Array.isArray(s.required) ? (s.required as string[]) : [],
    );
    for (const key of Object.keys(props))
      if (!required.has(key)) {
        const p = props[key];
        props[key] =
          p && typeof p === "object" && typeof p.type === "string"
            ? { ...p, type: [p.type, "null"] }
            : { anyOf: [p, { type: "null" }] };
      }
    s.properties = props;
    s.required = Object.keys(props);
    s.additionalProperties = false;
  }
  return s;
}

/** A finished JSON object from an agent's final message, if it has one. */
export function parseJson(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [text, fenced]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate.trim());
    } catch {}
  }
  return null;
}

/** What an agent is doing now, from an item it started. */
export function actionOf(item: any): string | undefined {
  if (!item || typeof item !== "object") return;
  if (item.type === "commandExecution" && typeof item.command === "string")
    return item.command.slice(0, 160);
  if (item.type === "fileChange") return "Editing files";
  if (item.type === "webSearch") return "Searching the web";
  if (item.type === "mcpToolCall" && typeof item.tool === "string")
    return `Using ${item.tool}`;
  return;
}

export const toolTypes = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "dynamicToolCall",
  "imageView",
]);
