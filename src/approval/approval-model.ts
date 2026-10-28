import type { Approval } from "../../shared/types";
import { alwaysScope, mcpToolApproval } from "../../shared/mcp-tool-approval";
import {
  approvalKind,
  type ApprovalChoice,
} from "../../shared/approval-response";

// The protocol answers moved to shared/ so the main process can answer a
// notification's Allow once with the card's own response.
export {
  approvalKind,
  approvalResponse,
  grantedPermissions,
  permissionRows,
  permissionTitle,
  type ApprovalChoice,
  type ApprovalKind,
  type PermissionRow,
  basename,
  approvalItem,
  fileChangeTitle,
  commandTitle,
} from "../../shared/approval-response";

/**
 * "Always allow" exists where Codex has a session-wide grant: commands, file
 * edits and permissions, unless the administrator turned session-wide grants
 * off (`approvalsAlwaysAllow`, enforced again by the engine).
 */
export function allowsAlways(
  approval: Approval,
  policy?: { approvalsAlwaysAllow?: boolean },
) {
  if (policy?.approvalsAlwaysAllow === false) return false;
  const kind = approvalKind(approval);
  if (kind === "elicitation") {
    const tool = mcpToolApproval(approval);
    if (tool) return alwaysScope(tool) !== undefined;
    return Boolean(browserApproval(approval)?.always);
  }
  return kind === "command" || kind === "fileChange" || kind === "permissions";
}

/**
 * Why Always allow is greyed rather than left out: the administrator's policy
 * turned remembered approvals off, or a connector tool offers no choice that
 * outlives the request.
 */
export function alwaysDisabledReason(
  approval: Approval,
  policy?: { approvalsAlwaysAllow?: boolean },
): string | undefined {
  const kind = approvalKind(approval);
  const tool = kind === "elicitation" ? mcpToolApproval(approval) : undefined;
  const could =
    kind === "command" ||
    kind === "fileChange" ||
    kind === "permissions" ||
    Boolean(tool);
  if (!could) return undefined;
  if (policy?.approvalsAlwaysAllow === false)
    return "Your admin’s settings require approval each time for this tool.";
  if (tool && alwaysScope(tool) === undefined)
    return "This tool requires approval each time.";
  return undefined;
}

export { sessionWideGrant } from "../../shared/approval-grants";

// ---------------------------------------------------------------------------
// Claude's Browser tools (R8-G)

/** The Codex MCP server that asks (electron/browser/mcp-tools.ts). */
export const browserApprovalServer = "claudex_browser";
/** The iOS Simulator tools ask the same way before a headless build. */
export const simulatorApprovalServer = "claudex_ios_simulator";
/** The one field of the browser approval form: "once" or "always". */
export const browserDecisionField = "decision";

export interface BrowserApproval {
  title: string;
  /** Lines under the title. */
  lines: string[];
  /** A command or script shown in a code box. */
  code?: string;
  /** The label of the allow button ("Allow once", or "Allow" for a dev server). */
  once: string;
  /** The label of the session-wide allow, when the question offers it. */
  always?: string;
}

const claudex = (text: string) => text.replace(/\bClaude\b/g, "Claudex");

/**
 * A question from the Browser tools as a card: the form the tools send is one
 * optional choice, which the card shows as its buttons instead of a form. The
 * tools' words name "Claude"; the app says Claudex (see the other cards'
 * titles). Undefined for any other elicitation.
 */
export function browserApproval(
  approval: Approval,
): BrowserApproval | undefined {
  const params = approval.params as
    | {
        serverName?: unknown;
        mode?: unknown;
        message?: unknown;
        requestedSchema?: {
          properties?: Record<string, { enum?: unknown; enumNames?: unknown }>;
        };
      }
    | undefined;
  if (
    approvalKind(approval) !== "elicitation" ||
    (params?.serverName !== browserApprovalServer &&
      params?.serverName !== simulatorApprovalServer &&
      params?.serverName !== "claudex_host") ||
    params.mode === "url" ||
    typeof params.message !== "string"
  )
    return undefined;
  const field = params.requestedSchema?.properties?.[browserDecisionField];
  const values = Array.isArray(field?.enum) ? field.enum.map(String) : [];
  if (!values.includes("once")) return undefined;
  const names = Array.isArray(field?.enumNames) ? field.enumNames : [];
  const label = (value: string, fallback: string) => {
    const name = names[values.indexOf(value)];
    return typeof name === "string" && name ? name : fallback;
  };
  const [title, ...rest] = params.message.split("\n");
  // A script is the text after a blank line; a command is the line "$ ...".
  const blank = rest.indexOf("");
  const script = blank >= 0 ? rest.slice(blank + 1).join("\n") : undefined;
  const body = blank >= 0 ? rest.slice(0, blank) : rest;
  const command = body.find((line) => line.startsWith("$ "));
  const lines = body.filter((line) => line !== command && line.trim());
  return {
    title: claudex(title),
    lines: lines.map(claudex),
    ...(command || script ? { code: command ?? script } : {}),
    once: label("once", "Allow once"),
    ...(values.includes("always")
      ? { always: label("always", "Always allow for this website") }
      : {}),
  };
}

/** The Workflow tool's "Run workflow?" question (electron/workflows/extension.ts). */
export const workflowApprovalServer = "claudex_workflow";
export const setupQuestionServer = "claudex_setup_question";

export function branchSetupApproval(
  approval: Approval,
): { suggested: string } | undefined {
  const params = approval.params as
    | { serverName?: unknown; setupQuestion?: unknown; suggested?: unknown }
    | undefined;
  if (
    approvalKind(approval) !== "elicitation" ||
    params?.serverName !== setupQuestionServer ||
    params.setupQuestion !== "branch"
  )
    return undefined;
  return {
    suggested:
      typeof params.suggested === "string"
        ? params.suggested
        : "claude/changes",
  };
}

/** The workflow a "Run workflow?" question is about; undefined for any other request. */
export function workflowApproval(
  approval: Approval,
): { name?: string; description?: string; managed?: boolean } | undefined {
  const params = approval.params as
    | {
        serverName?: unknown;
        workflowName?: unknown;
        workflowDescription?: unknown;
        workflowManaged?: unknown;
      }
    | undefined;
  if (
    approvalKind(approval) !== "elicitation" ||
    params?.serverName !== workflowApprovalServer
  )
    return undefined;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    name: text(params.workflowName),
    description: text(params.workflowDescription),
    ...(params.workflowManaged === true ? { managed: true } : {}),
  };
}

/** The response to a browser question: Deny declines; the buttons accept with their choice. */
export function browserApprovalResponse(choice: ApprovalChoice): unknown {
  return choice === "deny"
    ? { action: "decline", content: null, _meta: null }
    : {
        action: "accept",
        content: { [browserDecisionField]: choice },
        _meta: null,
      };
}
