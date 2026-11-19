import { randomUUID } from "node:crypto";
import { connectorUuid } from "./connector-auth";
import { ordinaryCommandApprovalTarget } from "../code-command-permission-host";
import { approvalResponse } from "../../../shared/approval-response";
import { z } from "zod";
import { elicitationFields } from "../../../shared/elicitation-form";
import {
  mcpElicitation,
  mcpElicitationResponse,
} from "../../../shared/mcp-elicitation";
import {
  mcpToolApproval,
} from "../../../shared/mcp-tool-approval";
import type { Approval, Conversation } from "../../../shared/types";

const fieldValue = z.object({
  fieldName: z.string(),
  value: z.discriminatedUnion("case", [
    z.object({ case: z.literal("stringValue"), value: z.string() }),
    z.object({ case: z.literal("booleanValue"), value: z.boolean() }),
    z.object({
      case: z.literal("numberValue"),
      value: z.union([z.bigint(), z.number(), z.string()]),
    }),
    z.object({
      case: z.literal("stringListValue"),
      value: z.object({ values: z.array(z.string()) }),
    }),
  ]),
});
const responseSchema = z.object({
  elicitationId: z.string().min(1),
  askNonce: z.string().min(1),
  response: z.object({
    verdict: z.number().optional(),
    approvalOption: z.number().optional(),
    stepUpDecision: z.number().optional(),
    alwaysAllowTools: z.unknown().optional(),
    values: z.array(fieldValue).optional(),
  }),
});
const questionSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        question: z.string().min(1),
        isOther: z.boolean().optional(),
        isSecret: z.boolean().optional(),
        options: z
          .array(
            z.object({
              label: z.string().min(1),
              description: z.string().optional(),
            }),
          )
          .nullish(),
      }),
    )
    .min(1),
});

type Offer =
  | { kind: "command"; command: string }
  | { kind: "mcp"; elicitation: NonNullable<ReturnType<typeof mcpElicitation>> }
  | { kind: "tool"; tool: NonNullable<ReturnType<typeof mcpToolApproval>> }
  | {
      kind: "questions";
      questions: z.infer<typeof questionSchema>["questions"];
    };
type Entry = {
  approval: Approval;
  fingerprint: string;
  offer: Offer;
  id: string;
  nonce: string;
  state: "pending" | "dispatching" | "unconfirmed" | "resolved";
  legacyToolUseId?: string;
};
export interface ChatElicitationPorts {
  load(
    conversationId: string,
  ): Promise<
    { conversation: Conversation; approvals: readonly Approval[] } | undefined
  >;
  dispatch(approval: Approval, response: unknown): Promise<void> | void;
  isCurrent(): boolean;
  urlAllowed?(approval: Approval): boolean;
}

function target(
  approval: Approval,
  c: Conversation,
): { offer: Offer; fingerprint: string } | undefined {
  const p = approval.params;
  const turn = c.turns.at(-1);
  if (
    c.mode !== "chat" ||
    c.archived ||
    c.id !== approval.conversationId ||
    !c.threadId ||
    !p ||
    p.threadId !== c.threadId ||
    !turn ||
    turn.status !== "inProgress" ||
    p.turnId !== turn.id ||
    c.turns.filter((t) => t.id === turn.id).length !== 1
  )
    return;
  let offer: Offer | undefined;
  const tool = mcpToolApproval(approval);
  const elicitation = mcpElicitation(approval);
  const command = approval.method === "item/commandExecution/requestApproval"
    ? ordinaryCommandApprovalTarget(approval, c) : undefined;
  if (command) return { offer: { kind: "command", command: command.input.command }, fingerprint: command.binding };
  if (
    tool &&
    tool.server &&
    tool.tool &&
    p._meta?.tool_params &&
    typeof p._meta.tool_params === "object" &&
    !Array.isArray(p._meta.tool_params)
  )
    offer = { kind: "tool", tool };
  else if (elicitation) offer = { kind: "mcp", elicitation };
  else if (
    ["item/tool/requestUserInput", "tool/requestUserInput"].includes(
      approval.method,
    )
  ) {
    const parsed = questionSchema.safeParse(p);
    if (
      parsed.success &&
      parsed.data.questions.every((q) => !q.isSecret) &&
      new Set(parsed.data.questions.map((q) => q.id)).size ===
        parsed.data.questions.length
    )
      offer = { kind: "questions", questions: parsed.data.questions };
  }
  if (!offer) return;
  return {
    offer,
    fingerprint: JSON.stringify([
      c.id,
      c.createdAt,
      c.threadId,
      c.activeBranchId,
      turn.id,
      turn.createdAt,
      approval.method,
      p,
    ]),
  };
}

function fieldsFor(offer: Offer) {
  if (offer.kind === "mcp" && offer.elicitation.mode === "form")
    return elicitationFields(offer.elicitation.requestedSchema).map((f) => ({
      name: f.name,
      label: f.label,
      description: f.description,
      required: f.required,
      type:
        f.type === "enum"
          ? 1
          : f.type === "multi"
            ? 4
            : f.type === "boolean"
              ? 3
              : 2,
      textKind:
        f.type === "integer"
          ? 1
          : f.type === "number"
            ? 2
            : f.format === "email"
              ? 3
              : f.format === "uri"
                ? 4
                : f.format === "date"
                  ? 5
                  : f.format === "date-time"
                    ? 6
                    : 0,
      options: f.options,
    }));
  if (offer.kind === "questions")
    return offer.questions.map((q) => ({
      name: q.id,
      label: q.question,
      type: q.options?.length ? 1 : 2,
      options: (q.options ?? []).map((o) => ({
        value: o.label,
        label: o.label,
        description: o.description,
      })),
      required: false,
    }));
  if (offer.kind === "tool" || offer.kind === "command")
    return [
      {
        name: "decision",
        type: 1,
        label: "Decision",
        options: [
          { value: "once", label: "Allow once", approvalOption: 1 },
          { value: "deny", label: "Decline", isDeny: true },
        ],
      },
    ];
  return [];
}

function project(
  entry: Entry,
  conversationId: string,
  index: number,
  toolUseId?: string,
  urlAllowed = true,
) {
  const { offer } = entry;
  const common = {
    status: 1,
    askNonce: entry.nonce,
    holdsConversation: true,
    requiresUserInteraction: true,
  };
  const request =
    offer.kind === "mcp"
      ? {
          ...common,
          kind: 3,
          originServerId: connectorUuid(offer.elicitation.serverName),
          ...(toolUseId ? { toolUseId } : {}),
          description: offer.elicitation.message,
          fields: fieldsFor(offer),
          ...(offer.elicitation.mode === "url"
            ? { externalUrl: urlAllowed ? offer.elicitation.url : "", trigger: 1 }
            : {
                mcpRequestedSchema: JSON.stringify(
                  offer.elicitation.requestedSchema,
                ),
              }),
        }
      : offer.kind === "questions"
        ? {
            ...common,
            kind: 2,
            fields: fieldsFor(offer),
          }
        : {
            ...common,
            kind: 1,
            title: offer.kind === "command" ? "Allow this command?" : `Allow ${offer.tool.title ?? offer.tool.tool}?`,
            description: offer.kind === "command" ? "Allow Claudex to run this command?" : `Allow ${offer.tool.server} to run this tool?`,
            descriptionFormat: { style: 2 },
            requester: { kind: 2 },
            acceptsTypedAnswer: true,
            fields: fieldsFor(offer),
            reportedAction: offer.kind === "command"
              ? { toolName: "Bash", toolInput: JSON.stringify({ command: offer.command }) }
              : { toolName: `mcp__${offer.tool.server}__${offer.tool.tool}`,
                  toolInput: JSON.stringify(entry.approval.params._meta.tool_params) },
          };
  return { id: entry.id, conversationId, index, request };
}

function answer(
  entry: Entry,
  parsed: z.infer<typeof responseSchema>,
): unknown | undefined {
  const { response } = parsed;
  if (
    Object.entries(response).some(
      ([key, value]) =>
        ![
          "$typeName",
          "values",
          "verdict",
          "approvalOption",
          "stepUpDecision",
          "alwaysAllowTools",
        ].includes(key) &&
        value !== undefined &&
        value !== null &&
        value !== "" &&
        value !== 0 &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0),
    )
  )
    return;
  if (
    ![undefined, 0, 1, 2].includes(response.verdict) ||
    ![undefined, 0, 1].includes(response.approvalOption) ||
    ![undefined, 0].includes(response.stepUpDecision) ||
    response.alwaysAllowTools != null
  )
    return;
  const values = new Map<string, unknown>();
  for (const field of response.values ?? []) {
    if (values.has(field.fieldName)) return;
    values.set(
      field.fieldName,
      field.value.case === "stringListValue"
        ? field.value.value.values
        : field.value.value,
    );
  }
  if (entry.offer.kind === "mcp") {
    if (response.verdict === 2)
      return values.size
        ? undefined
        : mcpElicitationResponse(entry.approval, { action: "decline" });
    if (entry.offer.elicitation.mode === "url")
      return values.size
        ? undefined
        : mcpElicitationResponse(entry.approval, { action: "accept" });
    const content: Record<string, unknown> = {};
    const fields = elicitationFields(entry.offer.elicitation.requestedSchema);
    for (const [name, value] of values) {
      const f = fields.find((f) => f.name === name);
      if (!f) return;
      content[name] =
        f.type === "number" || f.type === "integer"
          ? typeof value === "string" && value.trim()
            ? Number(value)
            : typeof value === "bigint"
              ? Number(value)
              : value
          : value;
    }
    return mcpElicitationResponse(entry.approval, {
      action: "accept",
      content,
    });
  }
  if (entry.offer.kind === "questions") {
    const questions = entry.offer.questions;
    if (
      response.verdict === 2 ||
      [...values.keys()].some((k) => !questions.some((q) => q.id === k))
    )
      return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of questions) {
      const value = values.get(q.id);
      if (value !== undefined && typeof value !== "string") return;
      if (
        value &&
        q.isOther === false &&
        q.options?.length &&
        !q.options.some((o) => o.label === value)
      )
        return;
      answers[q.id] = { answers: value ? [value] : [] };
    }
    return { answers };
  }
  const decision = values.get("decision");
  if (
    [...values.keys()].some((k) => k !== "decision" && k !== "tool_use_id") ||
    (values.has("tool_use_id") && values.get("tool_use_id") !== entry.id)
  )
    return;
  if (response.verdict === 2 || decision === "deny")
    return approvalResponse(entry.approval, "deny");
  if (response.verdict === 1 || decision === "once" || decision === "allow")
    return approvalResponse(entry.approval, "once");
}

function legacyToolUseId(
  entry: Entry,
  conversation: Conversation,
): string | undefined {
  if (entry.offer.kind !== "mcp") return;
  const serverName = entry.offer.elicitation.serverName;
  const turn = conversation.turns.at(-1);
  const items =
    turn?.items.filter(
      (item) =>
        item.type === "mcpToolCall" &&
        item.server === serverName &&
        ["running", "inProgress"].includes(
          item.lifecycleStatus ?? item.status ?? "",
        ),
    ) ?? [];
  return turn && items.length === 1 ? `${turn.id}:${items[0].id}` : undefined;
}

export class ChatElicitationHost {
  private readonly byApproval = new WeakMap<Approval, Entry>();
  private readonly byId = new Map<string, Entry>();
  constructor(private readonly ports: ChatElicitationPorts) {}
  async list(conversationId: string) {
    if (!this.ports.isCurrent()) return [];
    const snapshot = await this.ports.load(conversationId);
    if (!snapshot || !this.ports.isCurrent()) return [];
    const cards = [];
    for (const approval of snapshot.approvals) {
      const found = target(approval, snapshot.conversation);
      if (!found) continue;
      let entry = this.byApproval.get(approval);
      if (!entry || entry.fingerprint !== found.fingerprint) {
        entry = {
          approval,
          ...found,
          id: randomUUID(),
          nonce: randomUUID(),
          state: "pending",
        };
        this.byApproval.set(approval, entry);
        this.byId.set(entry.id, entry);
      }
      if (entry.state === "pending")
        cards.push(
          project(
            entry,
            conversationId,
            cards.length,
            legacyToolUseId(entry, snapshot.conversation),
            entry.offer.kind !== "mcp" || entry.offer.elicitation.mode !== "url" ||
              this.ports.urlAllowed?.(approval) !== false,
          ),
        );
    }
    return cards;
  }
  async legacyList(conversationId: string) {
    const cards = await this.list(conversationId);
    const snapshot = await this.ports.load(conversationId);
    if (!snapshot || !this.ports.isCurrent()) return [];
    return cards.flatMap((card) => {
      const entry = this.byId.get(card.id);
      if (
        !entry ||
        entry.offer.kind !== "mcp" ||
        entry.state !== "pending" ||
        !snapshot.approvals.includes(entry.approval)
      )
        return [];
      const found = target(entry.approval, snapshot.conversation);
      const toolUseId = legacyToolUseId(entry, snapshot.conversation);
      if (!found || found.fingerprint !== entry.fingerprint || !toolUseId)
        return [];
      entry.legacyToolUseId = toolUseId;
      const e = entry.offer.elicitation;
      return [
        {
          type: "mcp_elicitation",
          server_id: connectorUuid(e.serverName),
          tool_use_id: toolUseId,
          elicitation_id: entry.id,
          params:
            e.mode === "url"
              ? {
                  mode: "url",
                  url: this.ports.urlAllowed?.(entry.approval) === false ? "" : e.url,
                  message: e.message,
                  elicitationId: e.elicitationId,
                }
              : {
                  mode: "form",
                  message: e.message,
                  requestedSchema: e.requestedSchema,
                },
          trigger: "callback",
        },
      ];
    });
  }
  async respondLegacy(conversationId: string, id: string, value: unknown) {
    const entry = this.byId.get(id);
    if (!entry?.legacyToolUseId || entry.offer.kind !== "mcp")
      return { claimed: false as const };
    if (conversationId !== entry.approval.conversationId)
      return {
        claimed: true as const,
        error: {
          code: "invalid_argument",
          message: "The response does not match the displayed request.",
        },
      };
    const legacyUrlAccept = z
      .object({ action: z.literal("accept"), content: z.object({}).strict() })
      .strict()
      .safeParse(value);
    const normalized =
      entry.offer.elicitation.mode === "url" && legacyUrlAccept.success
        ? { action: "accept" }
        : value;
    const result = mcpElicitationResponse(entry.approval, normalized);
    if (!result)
      return {
        claimed: true as const,
        error: {
          code: "invalid_argument",
          message: "The response is not valid for this request.",
        },
      };
    return this.dispatch(entry, conversationId, result, true);
  }
  async respond(
    conversationId: string,
    value: unknown,
  ): Promise<
    | { claimed: false }
    | { claimed: true; error?: { code: string; message: string } }
  > {
    const raw = z.object({ elicitationId: z.string() }).safeParse(value);
    const entry = raw.success
      ? this.byId.get(raw.data.elicitationId)
      : undefined;
    if (!entry) return { claimed: false };
    const fail = (code: string, message: string) => ({
      claimed: true as const,
      error: { code, message },
    });
    const parsed = responseSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.askNonce !== entry.nonce ||
      conversationId !== entry.approval.conversationId
    )
      return fail(
        "invalid_argument",
        "The response does not match the displayed request.",
      );
    const result = answer(entry, parsed.data);
    if (!result)
      return fail(
        "invalid_argument",
        "The response is not valid for this request.",
      );
    return this.dispatch(entry, conversationId, result, false);
  }
  private async dispatch(
    entry: Entry,
    conversationId: string,
    result: unknown,
    legacy: boolean,
  ) {
    const fail = (code: string, message: string) => ({
      claimed: true as const,
      error: { code, message },
    });
    if (entry.state !== "pending" || !this.ports.isCurrent())
      return fail(
        "elicitation_unavailable",
        "This request is no longer available.",
      );
    entry.state = "dispatching";
    try {
      const snapshot = await this.ports.load(conversationId);
      const found = snapshot && target(entry.approval, snapshot.conversation);
      if (
        !this.ports.isCurrent() ||
        !snapshot ||
        !snapshot.approvals.includes(entry.approval) ||
        !found ||
        found.fingerprint !== entry.fingerprint ||
        (legacy &&
          legacyToolUseId(entry, snapshot.conversation) !==
            entry.legacyToolUseId)
      ) {
        entry.state = "resolved";
        return fail(
          "elicitation_unavailable",
          "This request is no longer available.",
        );
      }
      if (entry.offer.kind === "mcp" && entry.offer.elicitation.mode === "url" &&
          result && typeof result === "object" && "action" in result && result.action === "accept" &&
          this.ports.urlAllowed?.(entry.approval) === false) {
        entry.state = "pending";
        return fail("permission_denied", "Your administrator does not allow this link.");
      }
      await this.ports.dispatch(entry.approval, result);
      entry.state = "resolved";
      return { claimed: true as const };
    } catch {
      entry.state = "unconfirmed";
      return fail(
        "elicitation_unconfirmed",
        "The response could not be confirmed. Reopen the conversation to check its state.",
      );
    }
  }
}
