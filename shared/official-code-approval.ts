import { z } from "zod";
import { mcpElicitationDecision } from "./mcp-elicitation";

const object = z.record(z.string(), z.unknown());
export const codeCommandRequestPrefix = "code-command:";
const uuid = z.string().uuid();
const requestId = z.union([
  uuid,
  z
    .string()
    .startsWith(codeCommandRequestPrefix)
    .refine(
      (id) => uuid.safeParse(id.slice(codeCommandRequestPrefix.length)).success,
    ),
]);

export const officialCodeApprovalSuggestions = z.tuple([
  z.strictObject({
    type: z.literal("addRules"),
    behavior: z.literal("allow"),
    destination: z.literal("session"),
    rules: z
      .array(
        z.strictObject({
          toolName: z.string().min(1),
          ruleContent: z
            .string()
            .regex(/^[ -~]{1,200}$/)
            .regex(/[a-z0-9]/i),
        }),
      )
      .min(1)
      .max(5),
  }),
]);

export const officialCodeApprovalControl = z.strictObject({
  type: z.literal("control_request"),
  request_id: requestId,
  request: z.union([
    z.strictObject({
      subtype: z.literal("can_use_tool"),
      tool_use_id: z.string().min(1),
      tool_name: z.string().min(1),
      input: object,
      title: z.string().optional(),
      description: z.string().optional(),
      suppress_always_allow_rule: z.boolean(),
      permission_suggestions: officialCodeApprovalSuggestions.optional(),
      requires_user_interaction: z.literal(true),
    }),
    z.strictObject({
      subtype: z.literal("elicitation"),
      mcp_server_name: z.string().min(1),
      message: z.string(),
      mode: z.literal("form"),
      requested_schema: object,
      property_order: z.array(z.string()),
    }),
    z.strictObject({
      subtype: z.literal("elicitation"),
      mcp_server_name: z.string().min(1),
      message: z.string(),
      mode: z.literal("url"),
      url: z.string(),
      elicitation_id: z.string().optional(),
    }),
  ]),
});

export type OfficialCodeApprovalControl = z.infer<
  typeof officialCodeApprovalControl
>;

const decision = z.discriminatedUnion("behavior", [
  z.strictObject({
    behavior: z.literal("allow"),
    toolUseID: z.string().min(1),
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    updatedInput: object,
    updatedPermissions: officialCodeApprovalSuggestions.optional(),
  }),
  z.strictObject({
    behavior: z.literal("deny"),
    toolUseID: z.string().min(1),
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    message: z.string().min(1),
  }),
]);

const approvalPayload = z.strictObject({
  type: z.literal("control_response"),
  uuid: z.string().uuid().optional(),
  response: z.strictObject({
    subtype: z.literal("success"),
    request_id: requestId,
    response: z.union([decision, mcpElicitationDecision]),
  }),
});

export const officialWrappedApproval = z.strictObject({
  payload: approvalPayload.extend({ uuid: z.string().uuid() }),
});

export const officialCodeApprovalEvent = z.strictObject({
  session_id: z.string().optional(),
  events: z.tuple([officialWrappedApproval]),
});

export const officialCodeLegacyApprovalEvent = z.strictObject({
  session_id: z.string().optional(),
  events: z.tuple([approvalPayload]),
});

export type OfficialCodeApprovalReply = z.infer<
  typeof officialCodeApprovalEvent
>["events"][0]["payload"]["response"];
