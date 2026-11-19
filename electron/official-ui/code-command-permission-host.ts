/** Single-use, host-owned authority for local Code Bash and Write cards. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { grantedPermissions } from "../../shared/approval-response";
import {
  codeCommandRequestPrefix,
  officialCodeApprovalSuggestions,
} from "../../shared/official-code-approval";
import type { Approval, Conversation } from "../../shared/types";
import { isLocalCodeSession } from "./api/code-session-ownership";
import {
  fileWritePermission,
  type CodeToolPermissionSuggestion,
  type ToolPermission,
} from "./native/command-permission";

export interface CodeCommandPermissionPorts {
  current(): boolean;
  approvals(): readonly Approval[];
  conversation(id: string): Conversation | undefined;
  /** Runner sessions must belong to this engine's sandbox. Desktop defaults to local. */
  ownsEnvironment?(conversation: Conversation): boolean;
  /** The current app-server transport object; reconnecting retires old choices. */
  runtime(): object | undefined;
  canRespond?(approval: Approval): boolean;
  allowPersistent?(approval: Approval): boolean;
  surface?: "native" | "web";
  /** Synchronous exact-object dispatch into the captured local engine. */
  respondExact(approval: Approval, result: CodeExecutionApprovalResult): void;
}

const execPolicyChoice = z.strictObject({
  acceptWithExecpolicyAmendment: z.strictObject({
    execpolicy_amendment: z.array(z.string().min(1)).min(1),
  }),
});
type ApprovalScope = "turn" | "session";
export type CodeExecutionApprovalResult =
  | {
      decision:
        | "accept"
        | "decline"
        | "acceptForSession"
        | z.infer<typeof execPolicyChoice>;
    }
  | { permissions: Record<string, unknown>; scope: ApprovalScope };

const unavailable = () =>
  new Error("The approval is no longer available. No response was sent.");
const unconfirmed = () =>
  new Error(
    "The approval result is unconfirmed. It will not be sent again. Reopen the session to check its state.",
  );

/** Reject anything the ordinary command card cannot faithfully authorize. */
export function ordinaryCommandApprovalTarget(
  approval: Approval,
  c: Conversation,
) {
  const p = approval.params;
  if (
    c.id !== approval.conversationId ||
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    !c.threadId ||
    p.threadId !== c.threadId ||
    typeof p.turnId !== "string" ||
    !p.turnId ||
    typeof p.itemId !== "string" ||
    !p.itemId ||
    typeof p.command !== "string" ||
    !p.command.trim() ||
    p.command.length > 200000
  )
    return;
  if (p.environmentId != null && p.environmentId !== "local") return;
  if (
    [
      "networkApprovalContext",
      "additionalPermissions",
      "proposedNetworkPolicyAmendments",
      "proposedExecPolicyAmendment",
      "permissions",
      "requestedSchema",
      "url",
      "mode",
    ].some((key) => p[key] != null)
  )
    return;
  if (
    p.proposedExecpolicyAmendment != null &&
    !execPolicyChoice.safeParse({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: p.proposedExecpolicyAmendment,
      },
    }).success
  )
    return;
  if (
    p.availableDecisions != null &&
    (!Array.isArray(p.availableDecisions) ||
      !p.availableDecisions.includes("accept") ||
      !p.availableDecisions.every(
        (choice: unknown) =>
          (typeof choice === "string" &&
            ["accept", "acceptForSession", "decline", "cancel"].includes(
              choice,
            )) ||
          execPolicyChoice.safeParse(choice).success,
      ))
  )
    return;
  const turn = c.turns.at(-1);
  if (
    !turn ||
    turn.id !== p.turnId ||
    turn.status !== "inProgress" ||
    c.turns.filter((t) => t.id === turn.id).length !== 1
  )
    return;
  const items = turn.items.filter((item) => item.id === p.itemId);
  if (
    items.length !== 1 ||
    items[0].type !== "commandExecution" ||
    items[0].command !== p.command ||
    ["completed", "failed", "interrupted", "declined"].includes(
      items[0].status ?? "",
    ) ||
    ["completed", "failed", "interrupted", "declined"].includes(
      items[0].lifecycleStatus ?? "",
    )
  )
    return;
  return {
    toolName: "Bash" as const,
    input: { command: p.command as string },
    cliToolUseId: `${turn.id}:tool:${items[0].id}`,
    binding: JSON.stringify([
      approval.id,
      approval.method,
      c.id,
      c.createdAt,
      c.cwd,
      c.environment,
      c.threadId,
      c.activeBranchId,
      turn.id,
      turn.createdAt,
      p,
      items[0].id,
      items[0].command,
    ]),
  };
}

const optionalPaths = z.array(z.string().min(1)).nullish();
const additionalPermissions = z.strictObject({
  network: z.strictObject({ enabled: z.boolean().nullish() }).nullish(),
  fileSystem: z
    .strictObject({
      read: optionalPaths,
      write: optionalPaths,
      entries: z
        .array(
          z.strictObject({
            access: z.enum(["read", "write"]),
            path: z.strictObject({
              type: z.literal("path"),
              path: z.string().min(1),
            }),
          }),
        )
        .nullish(),
      globScanMaxDepth: z.null().optional(),
    })
    .nullish(),
});

function exactPermissions(value: unknown) {
  const parsed = additionalPermissions.safeParse(value);
  if (!parsed.success) return;
  const permissions = parsed.data;
  const fs = permissions.fileSystem;
  const read = [
    ...new Set([
      ...(fs?.read ?? []),
      ...(fs?.entries
        ?.filter((entry) => entry.access === "read")
        .map((entry) => entry.path.path) ?? []),
    ]),
  ];
  const write = [
    ...new Set([
      ...(fs?.write ?? []),
      ...(fs?.entries
        ?.filter((entry) => entry.access === "write")
        .map((entry) => entry.path.path) ?? []),
    ]),
  ];
  const network = permissions.network?.enabled;
  if (!network && !read.length && !write.length) return;
  const input = {
    ...(read.length ? { read } : {}),
    ...(write.length ? { write } : {}),
    ...(network ? { network: "All network destinations" } : {}),
  };
  return {
    input,
    permissions: grantedPermissions({
      ...(network ? { network: { enabled: true } } : {}),
      ...(fs && {
        fileSystem: {
          read: fs.read,
          write: fs.write,
          entries: fs.entries ?? undefined,
        },
      }),
    }),
  };
}

type LastingOffer = {
  suggestions: [CodeToolPermissionSuggestion];
  result: CodeExecutionApprovalResult;
};
type ApprovalTarget = Pick<
  ToolPermission,
  "toolName" | "input" | "cliToolUseId" | "description" | "decisionReason"
> & {
  binding: unknown;
  once: CodeExecutionApprovalResult;
  deny: CodeExecutionApprovalResult;
  lasting?: LastingOffer;
};

function lastingOffer(
  destination: CodeToolPermissionSuggestion["destination"],
  toolName: string,
  contents: string[],
  result: CodeExecutionApprovalResult,
  surface: CodeCommandPermissionPorts["surface"],
): LastingOffer | undefined {
  const suggestions: [CodeToolPermissionSuggestion] = [
    {
      type: "addRules",
      behavior: "allow",
      destination,
      rules: contents.map((ruleContent) => ({ toolName, ruleContent })),
    },
  ];
  if (
    surface === "web" &&
    !officialCodeApprovalSuggestions.safeParse(suggestions).success
  )
    return;
  return { suggestions, result };
}

function target(
  approval: Approval,
  c: Conversation | undefined,
  ports: CodeCommandPermissionPorts,
): ApprovalTarget | undefined {
  if (
    !c ||
    c.archived ||
    !(ports.ownsEnvironment
      ? c.mode === "code" &&
        !c.cloudHosted &&
        !c.cloudEnvironmentId &&
        !!c.cwd &&
        ports.ownsEnvironment(c)
      : isLocalCodeSession(c))
  )
    return;
  const p = approval.params;
  const turn = c.turns.at(-1);
  if (
    approval.conversationId !== c.id ||
    !c.threadId ||
    p?.threadId !== c.threadId ||
    !turn ||
    p.turnId !== turn.id ||
    turn.status !== "inProgress" ||
    c.turns.filter((entry) => entry.id === turn.id).length !== 1
  )
    return;
  const binding = [
    approval.id,
    approval.method,
    c.createdAt,
    c.cwd,
    c.environment,
    c.threadId,
    c.activeBranchId,
    c.sessionAuthors?.ownerAccountUuid,
    turn.createdAt,
    structuredClone(p),
  ];
  const canOfferStandingRule = !!ports.allowPersistent;
  const once = { decision: "accept" } as const;
  const deny = { decision: "decline" } as const;
  if (approval.method === "item/commandExecution/requestApproval") {
    const { additionalPermissions, ...ordinaryParams } = p;
    const ordinary = ordinaryCommandApprovalTarget(
      additionalPermissions == null
        ? approval
        : { ...approval, params: ordinaryParams },
      c,
    );
    if (!ordinary) return;
    const { toolName, input, cliToolUseId } = ordinary;
    if (additionalPermissions != null) {
      if (ports.surface === "web") return;
      const requested = exactPermissions(additionalPermissions);
      if (!requested) return;
      const limits = [
        ...(requested.input.network ? [requested.input.network] : []),
        ...(requested.input.read?.map((path) => `Read ${path}`) ?? []),
        ...(requested.input.write?.map((path) => `Write ${path}`) ?? []),
      ];
      return {
        toolName,
        input,
        cliToolUseId,
        binding,
        once,
        deny,
        description: `This command also requests the following access.
${limits.join("\n")}`,
        decisionReason: typeof p.reason === "string" ? p.reason : undefined,
      };
    }
    let lasting: LastingOffer | undefined;
    if (canOfferStandingRule) {
      const durableChoice = {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: p.proposedExecpolicyAmendment,
        },
      };
      const amendment = execPolicyChoice.safeParse(durableChoice);
      if (
        ports.surface !== "web" &&
        amendment.success &&
        Array.isArray(p.availableDecisions) &&
        p.availableDecisions.some((choice: unknown) =>
          isDeepStrictEqual(choice, amendment.data),
        )
      ) {
        const argv =
          amendment.data.acceptWithExecpolicyAmendment.execpolicy_amendment;
        const prefix = argv
          .map((arg) => (/^[\w./:\-]+$/.test(arg) ? arg : JSON.stringify(arg)))
          .join(" ");
        lasting = lastingOffer(
          "userSettings",
          toolName,
          [prefix + ":*"],
          { decision: amendment.data },
          ports.surface,
        );
      } else {
        lasting = lastingOffer(
          "session",
          toolName,
          [input.command],
          { decision: "acceptForSession" },
          ports.surface,
        );
      }
    }
    return { toolName, input, cliToolUseId, binding, once, deny, lasting };
  }
  if (approval.method === "item/permissions/requestApproval") {
    if (
      ports.surface === "web" ||
      (p.environmentId != null && p.environmentId !== "local") ||
      typeof p.itemId !== "string" ||
      !p.itemId
    )
      return;
    const requested = exactPermissions(p.permissions);
    if (!requested) return;
    return {
      toolName: "request_permissions",
      cliToolUseId: `${turn.id}:tool:${p.itemId}`,
      input: requested.input,
      description:
        "Allow once grants the listed access for the rest of this turn.",
      decisionReason: typeof p.reason === "string" ? p.reason : undefined,
      binding,
      once: { permissions: requested.permissions, scope: "turn" },
      deny: { permissions: {}, scope: "turn" },
    };
  }
  const write = fileWritePermission(approval, c);
  if (!write) return;
  const path = write.filePath;
  const lasting =
    canOfferStandingRule && typeof path === "string"
      ? lastingOffer(
          "session",
          write.toolName,
          [path],
          { decision: "acceptForSession" },
          ports.surface,
        )
      : undefined;
  return { ...write, binding, once, deny, lasting };
}

interface Entry {
  approval: Approval;
  runtime: object;
  target: NonNullable<ReturnType<typeof target>>;
  request: ToolPermission;
  state: "pending" | "unconfirmed" | "resolved" | "invalid";
  decision?: "once" | "deny" | "always";
}

export function createCodeCommandPermissionHost(
  ports: CodeCommandPermissionPorts,
) {
  const byRequest = new WeakMap<Approval, Entry>();
  const byToken = new Map<string, Entry>();
  let retired = false;
  const current = () => {
    if (retired) return false;
    try {
      if (ports.current() !== true) retired = true;
    } catch {
      retired = true;
    }
    return !retired;
  };
  const live = (approval: Approval) => {
    if (!current()) return;
    const requests = ports.approvals();
    if (
      !requests.includes(approval) ||
      requests.filter((a) => String(a.id) === String(approval.id)).length !== 1
    )
      return;
    const result = target(
      approval,
      ports.conversation(approval.conversationId),
      ports,
    );
    return current() ? result : undefined;
  };
  return {
    project(
      approvalId: string | number,
      conversationId: string,
    ): ToolPermission | undefined {
      if (!current()) throw unavailable();
      const matches = ports
        .approvals()
        .filter((a) => String(a.id) === String(approvalId));
      if (matches.length !== 1 || matches[0].conversationId !== conversationId)
        return;
      const approval = matches[0];
      let entry = byRequest.get(approval);
      const value = live(approval);
      const runtime = ports.runtime();
      if (
        !value ||
        !runtime ||
        (entry &&
          (!isDeepStrictEqual(entry.target, value) ||
            entry.runtime !== runtime))
      ) {
        if (entry?.state === "pending") entry.state = "invalid";
        return;
      }
      if (!entry) {
        if (byToken.size >= 2000)
          throw new Error(
            "Reopen the account before requesting more Code approvals.",
          );
        const offer = ports.allowPersistent?.(approval)
          ? value.lasting
          : undefined;
        entry = {
          approval,
          runtime,
          target: value,
          state: "pending",
          request: {
            requestId:
              (ports.surface === "web" ||
              approval.method === "item/commandExecution/requestApproval"
                ? codeCommandRequestPrefix
                : approval.method === "item/permissions/requestApproval"
                  ? "code-permissions:"
                  : "code-write:") + randomUUID(),
            sessionId: `local_${conversationId}`,
            toolName: value.toolName,
            input: value.input,
            cliToolUseId: value.cliToolUseId,
            description: value.description,
            decisionReason: value.decisionReason,
            ...(offer
              ? {
                  suggestions: offer.suggestions,
                  ...(offer.suggestions[0].destination === "session"
                    ? { alwaysAllowEndsWithSession: true }
                    : {}),
                }
              : { suppressAlwaysAllowRule: true }),
          },
        };
        byRequest.set(approval, entry);
        byToken.set(entry.request.requestId, entry);
      }
      if (entry.state === "pending" || entry.state === "unconfirmed")
        return structuredClone({
          ...entry.request,
          ...(entry.state === "unconfirmed"
            ? {
                title: "Code approval result is unconfirmed",
              }
            : {}),
        });
    },
    respond(
      requestId: string,
      decision: string,
      updatedInput?: unknown,
      binding?: {
        sessionId: string;
        toolUseId: string;
        toolNames?: readonly string[];
      },
      updatedPermissions?: unknown,
    ): void {
      if (!current()) throw unavailable();
      if (decision !== "once" && decision !== "deny" && decision !== "always")
        throw new Error(
          "Only allow once or deny is supported for Code approvals.",
        );
      const entry = byToken.get(requestId);
      if (
        !entry ||
        (binding &&
          (entry.request.sessionId !== binding.sessionId ||
            entry.request.cliToolUseId !== binding.toolUseId ||
            binding.toolNames?.some(
              (toolName) => toolName !== entry.request.toolName,
            )))
      )
        throw unavailable();
      if (updatedPermissions !== undefined && decision !== "always")
        throw new Error("Unexpected standing approval rules.");
      if (
        decision === "always" &&
        (!entry.request.suggestions ||
          (ports.surface === "web" &&
            !isDeepStrictEqual(updatedPermissions, entry.request.suggestions)))
      )
        throw new Error(
          "Only allow once or deny is supported for this Code approval.",
        );
      if (
        updatedInput !== undefined &&
        !isDeepStrictEqual(updatedInput, entry.request.input)
      )
        throw new Error("Edited approval input is not supported yet.");
      const result =
        decision === "always"
          ? entry.target.lasting?.result
          : entry.target[decision];
      if (!result) throw unavailable();
      if (entry.state === "resolved" && entry.decision === decision) return;
      if (entry.state === "invalid" || entry.state === "resolved")
        throw unavailable();
      if (entry.state !== "pending") throw unconfirmed();
      const value = live(entry.approval);
      if (
        !value ||
        !isDeepStrictEqual(value, entry.target) ||
        ports.runtime() !== entry.runtime
      ) {
        entry.state = "invalid";
        throw unavailable();
      }
      if (ports.canRespond?.(entry.approval) === false) throw unavailable();
      if (
        decision === "always" &&
        ports.allowPersistent?.(entry.approval) !== true
      )
        throw new Error(
          "Only allow once or deny is supported for this Code approval.",
        );
      // Reserve before dispatch. A synchronous failure may follow an actual write.
      entry.state = "unconfirmed";
      entry.decision = decision;
      try {
        ports.respondExact(entry.approval, result);
        if (
          !current() ||
          ports.runtime() !== entry.runtime ||
          ports.approvals().includes(entry.approval)
        )
          throw unconfirmed();
      } catch {
        throw unconfirmed();
      }
      entry.state = "resolved";
    },
  };
}

export type CodeCommandPermissionHost = ReturnType<
  typeof createCodeCommandPermissionHost
>;
