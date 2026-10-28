import type { CodeSandbox, Mode, Settings } from "./types";
import {
  preference,
  type SettingsPreferences,
  type TaskPermission,
} from "./settings-extras";

/**
 * The sandbox a turn runs in. Both stored Chat and Cowork sessions follow the
 * unified permission picker observed on the current official Chat. Code follows
 * its own picker. Windows follows the same rules as macOS and Linux: Codex's
 * unelevated Windows sandbox applies edits inside the workspace and refuses
 * writes outside it.
 */
export function effectiveTurnSandbox(
  _platform: NodeJS.Platform,
  _mode: Mode,
  requested: CodeSandbox,
): CodeSandbox {
  return requested;
}

/**
 * A task's sandbox for its permission mode: Manual and Auto work in their
 * folders and ask (Manual asks the person, Auto its reviewer) before
 * anything else; Full access never asks.
 */
export function taskSandboxFor(
  settings: SettingsPreferences,
  /**
   * A scheduled task's run: full access unless the task chose Manual or Auto
   * (`scheduledPermission`); a task saved before the choice has full access.
   */
  scheduledRun = false,
  /** A task from an outside prompt asks first (Conversation.asksFirst). */
  asksFirst = false,
  /** The permission mode a scheduled task was saved with. */
  scheduledPermission?: TaskPermission,
): CodeSandbox {
  if (asksFirst) return "workspace-write";
  if (scheduledRun)
    return (scheduledPermission ?? "bypass") === "bypass"
      ? "danger-full-access"
      : "workspace-write";
  return preference(settings, "taskPermission") === "bypass"
    ? "danger-full-access"
    : "workspace-write";
}

/**
 * A Code session started by a scheduled task that was saved with a permission
 * mode: Skip all approvals is full access only where Bypass permissions mode
 * applies to Code (the person's own switch, and a folder they confirmed or the
 * web runner's "*"); elsewhere it works in the folder and asks, as Code does.
 * Manual and Auto work in the folder and ask. Undefined for a task without a
 * mode, which follows the Code setting as before.
 */
export function scheduledCodeSandbox(
  settings: Pick<Settings, "allowBypassPermissions" | "bypassFolders">,
  permission?: TaskPermission,
  cwd?: string,
): CodeSandbox | undefined {
  if (!permission) return undefined;
  return permission === "bypass" &&
    preference(settings, "allowBypassPermissions") &&
    cwd &&
    (settings.bypassFolders?.includes(cwd) ||
      settings.bypassFolders?.includes(anyFolder))
    ? "danger-full-access"
    : "workspace-write";
}

/**
 * Who answers a turn's approval requests: in an Auto task, Codex's automatic
 * reviewer (`approvalsReviewer: "auto_review"`, a second model that sees the
 * request and the conversation but not tool output, as the official Auto
 * mode's classifier); otherwise the person.
 */
export function approvalsReviewerFor(
  mode: Mode,
  settings: SettingsPreferences,
  scheduledRun = false,
  /** A task from an outside prompt: the person answers (Manual). */
  asksFirst = false,
  /** The permission mode a scheduled task was saved with. */
  scheduledPermission?: TaskPermission,
): "user" | "auto_review" {
  if (scheduledRun)
    return scheduledPermission === "auto" ? "auto_review" : "user";
  return mode !== "code" &&
    !asksFirst &&
    preference(settings, "taskPermission") === "auto"
    ? "auto_review"
    : "user";
}

/**
 * Code's sandbox for a folder. Bypass permissions maps to Codex full access,
 * but only in folders where the user confirmed it; elsewhere Code behaves as
 * Auto. Plan mode is always read-only.
 */
/** The bypassFolders entry that confirms every folder (the web runner). */
export const anyFolder = "*";

export function codeSandboxFor(
  settings: Pick<
    Settings,
    "codeSandbox" | "codePlanMode" | "bypassFolders" | "allowBypassPermissions"
  >,
  cwd?: string,
): CodeSandbox {
  if (settings.codePlanMode) return "read-only";
  if (settings.codeSandbox !== "danger-full-access")
    return settings.codeSandbox;
  // Settings → Claude Code → "Allow bypass permissions mode" is the user's own
  // switch; administrators cannot turn Bypass off. "*" confirms every folder:
  // the web runner's sessions, which run in their own sandbox.
  return preference(settings, "allowBypassPermissions") &&
    cwd &&
    (settings.bypassFolders?.includes(cwd) ||
      settings.bypassFolders?.includes(anyFolder))
    ? "danger-full-access"
    : "workspace-write";
}

/** Full access asks for nothing; every other sandbox asks when it needs to. */
export const approvalPolicyFor = (sandbox: CodeSandbox): ApprovalPolicy =>
  sandbox === "danger-full-access" ? "never" : "on-request";

/** Codex's approval policy (app-server AskForApproval, 0.144.1). */
export type ApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        mcp_elicitations: boolean;
        request_permissions?: boolean;
        skill_approval?: boolean;
      };
    };

/**
 * A Code turn's sandbox and approval policy with the session's Local sandbox
 * and Strict sandbox choices:
 *
 * - Plan mode (read-only) and Bypass (full access) are unchanged.
 * - Local sandbox on: the folder's sandbox; a command that needs to leave it
 *   asks (on-request). With Strict sandbox mode it is refused instead: nothing
 *   escalates out of the sandbox, everything else still asks.
 * - Local sandbox off: no sandbox, but every command that isn't known to be
 *   safe asks first (untrusted). Never silently full access.
 */
export function codeTurnPermissions(
  sandbox: CodeSandbox,
  session: { localSandboxOff?: boolean; strictSandbox?: boolean },
): { sandbox: CodeSandbox; approvalPolicy: ApprovalPolicy } {
  if (sandbox !== "workspace-write")
    return { sandbox, approvalPolicy: approvalPolicyFor(sandbox) };
  if (session.localSandboxOff)
    return { sandbox: "danger-full-access", approvalPolicy: "untrusted" };
  if (session.strictSandbox)
    return {
      sandbox,
      approvalPolicy: {
        granular: {
          sandbox_approval: false,
          rules: true,
          mcp_elicitations: true,
          request_permissions: true,
          skill_approval: true,
        },
      },
    };
  return { sandbox, approvalPolicy: "on-request" };
}

/**
 * The turn/start `sandboxPolicy` for a turn's sandbox (R11-D). Extra writable
 * folders only widen a workspace-write turn (Cowork's added folders); read-only
 * and full access carry none. Codex keeps a turn's policy for later turns, so a
 * caller that sends one sends one every turn. `network` lets commands use the
 * network the engine itself has: off on a computer; on in the web runner, whose
 * gVisor sandbox already limits the network and cannot set up the separate
 * network Codex gives a command otherwise (#22: every restricted command failed
 * at "RTM_NEWADDR"). `outer`: the turn already runs in that gVisor sandbox, so
 * a turn that works in its folder is Codex's external sandbox. Codex reads a
 * file it patches through a helper with a network of its own, which gVisor
 * can't give it either.
 */
export function turnSandboxPolicy(
  sandbox: CodeSandbox,
  cwd: string,
  extraRoots: readonly string[] = [],
  network = false,
  outer = false,
) {
  if (sandbox === "read-only")
    return { type: "readOnly" as const, networkAccess: network };
  if (sandbox === "danger-full-access")
    return { type: "dangerFullAccess" as const };
  if (outer)
    return {
      type: "externalSandbox" as const,
      networkAccess: network ? ("enabled" as const) : ("restricted" as const),
    };
  return {
    type: "workspaceWrite" as const,
    writableRoots: [cwd, ...extraRoots.filter((root) => root !== cwd)],
    networkAccess: network,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
