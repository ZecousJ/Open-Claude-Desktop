import { z } from "zod";
import {
  elicitationFields,
  elicitationResult,
  type FormValues,
} from "./elicitation-form";
import { httpsPage } from "./external-links";
import { mcpToolApproval } from "./mcp-tool-approval";
import type { Approval } from "./types";

const formField = z.looseObject({
  type: z.enum(["string", "number", "integer", "boolean", "array"]),
  format: z.enum(["email", "uri", "date", "date-time"]).optional(),
  pattern: z.never().optional(),
});
const formSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), formField),
  required: z.array(z.string()).optional(),
});
const params = z.looseObject({
  serverName: z.string().min(1),
  message: z.string(),
  mode: z.enum(["form", "url"]).optional(),
  requestedSchema: z.unknown().optional(),
  url: z.string().optional(),
  elicitationId: z.string().optional(),
});

export const mcpElicitationDecision = z.union([
  z.strictObject({
    action: z.literal("accept"),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({ action: z.enum(["decline", "cancel"]) }),
]);

export function mcpElicitation(approval: Approval) {
  if (
    approval.method !== "mcpServer/elicitation/request" ||
    mcpToolApproval(approval)
  )
    return;
  const parsed = params.safeParse(approval.params);
  if (!parsed.success) return;
  const { mode, serverName, message, url, elicitationId, requestedSchema } =
    parsed.data;
  if (mode === "url") {
    const href = httpsPage(url);
    if (!href) return;
    return { mode, serverName, message, url: href, elicitationId } as const;
  }
  const form = formSchema.safeParse(requestedSchema);
  if (!form.success) return;
  const fieldNames = Object.keys(form.data.properties);
  if (
    fieldNames.some((key) => key === "__proto__") ||
    form.data.required?.some((key) => !Object.hasOwn(form.data.properties, key))
  )
    return;
  return {
    mode: "form",
    serverName,
    message,
    requestedSchema: form.data,
    fieldNames,
  } as const;
}

export function mcpElicitationResponse(approval: Approval, value: unknown) {
  const elicitation = mcpElicitation(approval);
  const decision = mcpElicitationDecision.safeParse(value);
  if (!elicitation || !decision.success) return;
  const { action } = decision.data;
  if (action !== "accept") return { action, content: null, _meta: null };
  const { content } = decision.data;
  if (elicitation.mode === "url")
    return content === undefined
      ? { action, content: null, _meta: null }
      : undefined;
  if (!content) return;
  const fields = elicitationFields(elicitation.requestedSchema);
  const values: FormValues = {};
  for (const [key, input] of Object.entries(content)) {
    const field = fields.find((field) => field.name === key);
    if (!field) return;
    switch (field.type) {
      case "boolean":
        if (typeof input !== "boolean") return;
        values[key] = input;
        break;
      case "integer":
      case "number":
        if (typeof input !== "number") return;
        values[key] = String(input);
        break;
      case "multi":
        if (
          !Array.isArray(input) ||
          !input.every(
            (item): item is string =>
              typeof item === "string" &&
              field.options.some((option) => option.value === item),
          )
        )
          return;
        values[key] = input;
        break;
      case "enum":
      case "string":
        if (
          typeof input !== "string" ||
          (field.type === "enum" &&
            !field.options.some((option) => option.value === input))
        )
          return;
        values[key] = input;
        break;
    }
  }
  if (
    fields.some((field) => field.required && !Object.hasOwn(values, field.name))
  )
    return;
  const result = elicitationResult(
    fields.filter((field) => Object.hasOwn(values, field.name)),
    values,
  );
  if ("problem" in result) return;
  return { action, content, _meta: null };
}
