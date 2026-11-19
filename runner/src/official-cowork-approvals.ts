import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  officialApprovalResponse,
  officialMcpApprovalRequest,
} from "../../electron/official-ui/api/cloud-code-approval";
import {
  cloudCodeSessionKey,
  isOwnedCloudCoworkSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { ordinaryCommandApprovalTarget } from "../../electron/official-ui/code-command-permission-host";
import {
  officialWrappedApproval,
  type OfficialCodeApprovalControl,
} from "../../shared/official-code-approval";
import {
  officialCodeFollowupMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { Approval, Conversation } from "../../shared/types";
import type { WebAppContext } from "./web-app-context";

const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});

const controlResponseBatch = z.object({
  events: z.array(z.object({ payload: z.object({ type: z.string() }) })),
});
const coworkApprovalBatch = z.strictObject({
  session_id: z.string().optional(),
  events: officialWrappedApproval.array().min(1).max(64),
});

function ownedSession(
  ctx: WebAppContext,
  matches: (row: Conversation, owner: string) => boolean,
) {
  const owner = ctx.activeAccount?.id;
  if (!owner) return;
  const rows = ctx.store.conversations.filter((row) => matches(row, owner));
  if (rows.length === 1 && isOwnedCloudCoworkSession(rows[0], owner))
    return rows[0];
}

export function officialCoworkApprovalSession(ctx: WebAppContext, key: string) {
  return ownedSession(
    ctx,
    (row, owner) => cloudCodeSessionKey(row, owner) === key,
  );
}

function approvalScope(ctx: WebAppContext, conversation: Conversation) {
  const identity = ctx.officialSessionIdentity();
  if (
    !identity ||
    ctx.closedFlag ||
    ctx.signedOut ||
    ctx.accountRetiring ||
    conversation.archived
  )
    return;
  const engine = ctx.engines.running(conversation.id);
  const rpc = engine?.rpc;
  if (
    !engine ||
    !rpc?.connected ||
    !engine.owns(conversation) ||
    !conversation.threadId ||
    engine.routes.get(conversation.threadId) !== conversation.id
  )
    return;
  return { ctx, identity, store: ctx.store, conversation, engine, rpc };
}

type ApprovalScope = NonNullable<ReturnType<typeof approvalScope>>;
type CoworkControl = OfficialCodeApprovalControl & {
  request: Exclude<OfficialCodeApprovalControl["request"], { mode: "form" }>;
};
const offered = new WeakMap<
  Approval,
  {
    scope: ApprovalScope;
    control: CoworkControl;
    consumed: boolean;
  }
>();

function requestFor(scope: ApprovalScope, approval: Approval) {
  if (approval.method === "item/commandExecution/requestApproval") {
    const command = ordinaryCommandApprovalTarget(approval, scope.conversation);
    if (!command) return;
    return {
      subtype: "can_use_tool" as const,
      tool_use_id: command.cliToolUseId,
      tool_name: command.toolName,
      input: command.input,
      suppress_always_allow_rule: true as const,
      requires_user_interaction: true as const,
    };
  }
  const request = officialMcpApprovalRequest(scope.conversation, approval);
  return request?.subtype === "elicitation" && request.mode === "form"
    ? undefined
    : request;
}

function controlFor(
  request: NonNullable<ReturnType<typeof requestFor>>,
  requestId: string,
): CoworkControl {
  return {
    type: "control_request",
    request_id: requestId,
    request:
      request.subtype === "can_use_tool"
        ? { ...request, tool_use_id: request.tool_use_id ?? requestId }
        : request,
  };
}

function sameScope(a: ApprovalScope, b: ApprovalScope) {
  return (
    a.ctx === b.ctx &&
    a.identity === b.identity &&
    a.store === b.store &&
    a.conversation === b.conversation &&
    a.engine === b.engine &&
    a.rpc === b.rpc
  );
}

export function officialCoworkApprovalControls(ctx: WebAppContext, id: string) {
  const conversation = ownedSession(ctx, (row) => row.id === id);
  const scope = conversation && approvalScope(ctx, conversation);
  if (!scope) return [];
  const approvals = scope.engine.ownApprovals;
  return approvals.flatMap((approval) => {
    if (
      approval.conversationId !== id ||
      approvals.filter((other) => other.id === approval.id).length !== 1
    )
      return [];
    const prior = offered.get(approval);
    if (prior?.consumed) return [];
    const previous =
      prior && sameScope(prior.scope, scope) ? prior.control : undefined;
    const request = requestFor(scope, approval);
    if (!request) {
      offered.delete(approval);
      return [];
    }
    if (
      previous &&
      isDeepStrictEqual(previous, controlFor(request, previous.request_id))
    )
      return [previous];
    const control = structuredClone(controlFor(request, randomUUID()));
    offered.set(approval, { scope, control, consumed: false });
    return [control];
  });
}

export function respondOfficialCoworkApproval(
  ctx: WebAppContext,
  conversation: Conversation,
  key: string,
  request: Record<string, unknown>,
  current: () => boolean,
): OfficialUiReadResponse | undefined {
  const stale = () =>
    json(409, { error: "The Cowork approval is no longer available." });
  const invalid = () =>
    json(400, { error: "The response does not match the Cowork approval." });
  const account = ctx.activeAccount;
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > officialCodeFollowupMaxBytes ||
    typeof request.contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(request.contentType)
  )
    return;
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
  } catch {
    return;
  }
  const batch = controlResponseBatch.safeParse(body);
  if (
    !batch.success ||
    !batch.data.events.some(
      ({ payload }) => payload.type === "control_response",
    )
  )
    return;
  if (!current() || !account) return stale();
  if (
    typeof request.codeOrganizationId !== "string" ||
    request.codeOrganizationId.toLowerCase() !== organizationUuid(account.id)
  )
    return json(404, { error: "Organization not found." });
  const event = coworkApprovalBatch.safeParse(body);
  if (!event.success) return invalid();
  const { session_id, events } = event.data;
  if (
    session_id !== undefined &&
    session_id !== `session_${key}` &&
    session_id !== `cse_${key}`
  )
    return invalid();
  if (
    new Set(events.map(({ payload }) => payload.uuid)).size !== events.length ||
    new Set(events.map(({ payload }) => payload.response.request_id)).size !==
      events.length
  )
    return invalid();
  const scope = approvalScope(ctx, conversation);
  if (!scope) return stale();
  const approvals = scope.engine.ownApprovals;
  const ready = [];
  for (const {
    payload: { response: reply },
  } of events) {
    const approval = approvals.find(
      (candidate) =>
        offered.get(candidate)?.control.request_id === reply.request_id,
    );
    const offer = approval && offered.get(approval);
    if (
      !approval ||
      !offer ||
      offer.consumed ||
      !sameScope(offer.scope, scope) ||
      approvals.filter((candidate) => candidate.id === approval.id).length !== 1
    )
      return stale();
    const request = requestFor(scope, approval);
    if (
      !request ||
      !isDeepStrictEqual(offer.control, controlFor(request, reply.request_id))
    )
      return stale();
    if (
      offer.control.request.subtype === "elicitation" &&
      (!("action" in reply.response) || reply.response.action === "cancel")
    )
      return invalid();
    const result = officialApprovalResponse(
      approval,
      offer.control.request,
      reply.response,
    );
    if (result.kind === "invalid") return invalid();
    ready.push({ approval, offer, result });
  }
  for (const { approval, offer, result } of ready) {
    const latest = approvalScope(ctx, conversation);
    const matches = scope.engine.ownApprovals.filter(
      (candidate) => candidate.id === approval.id,
    );
    if (
      !current() ||
      !latest ||
      !sameScope(scope, latest) ||
      !isOwnedCloudCoworkSession(conversation, account.id) ||
      !scope.store.conversations.includes(conversation) ||
      matches.length !== 1 ||
      matches[0] !== approval ||
      offered.get(approval) !== offer ||
      offer.consumed
    )
      return stale();
    offer.consumed = true;
    try {
      scope.engine.approve(result.id, result.response);
    } catch {
      return stale();
    }
  }
  return json(200, { events: [] });
}
