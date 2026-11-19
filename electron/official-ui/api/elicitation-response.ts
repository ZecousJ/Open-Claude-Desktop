import { CommandDeclineError } from "../command-decline-host";
import type { AdapterContext } from "./context";

/** Frozen protocol uses verdict enums, NOT response oneofs. Never default to approval. */
export function elicitationRefusal(value: unknown): {
  code: string;
  message: string;
} {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (
    !record(value) ||
    typeof value.elicitationId !== "string" ||
    !value.elicitationId ||
    value.elicitationId.length > 512 ||
    !record(value.response)
  )
    return {
      code: "invalid_argument",
      message: "An explicit, identified elicitation response is required.",
    };
  const response = value.response;
  if (response.verdict !== 1 && response.verdict !== 2)
    return {
      code: "invalid_argument",
      message: "This elicitation verdict is missing or unsupported.",
    };
  if (
    (response.approvalOption !== undefined &&
      response.approvalOption !== 0 &&
      response.approvalOption !== 1) ||
    (response.stepUpDecision !== undefined && response.stepUpDecision !== 0) ||
    response.alwaysAllowTools !== undefined ||
    (response.values !== undefined &&
      (!Array.isArray(response.values) || response.values.length > 0))
  )
    return {
      code: "unimplemented",
      message:
        "Forms, URL verification and persistent or expanded tool permissions are not supported by this adapter.",
    };
  // A host without the scoped capability has no elicitation→request/nonce
  // binding. An ID string (or the latest pending approval) is not such proof.
  // Even an explicit decline must not target an unrelated current request.
  return {
    code: "unimplemented",
    message:
      response.verdict === 2
        ? "This decline could not be matched to an authenticated pending request. No approval or cancellation was sent; use the existing Claudex approval interface."
        : "This approval could not be matched to an authenticated pending request. No tool permission was granted; use the existing Claudex approval interface.",
  };
}

/** The original decline-only card sends exactly these two legacy fields. */
function ordinaryDeclineFields(values: unknown, elicitationId: unknown) {
  if (
    !Array.isArray(values) ||
    values.length !== 2 ||
    typeof elicitationId !== "string"
  )
    return false;
  const fields = new Map<string, string>();
  for (const field of values) {
    if (
      !field ||
      typeof field !== "object" ||
      typeof field.fieldName !== "string" ||
      fields.has(field.fieldName) ||
      field.value?.case !== "stringValue" ||
      typeof field.value.value !== "string"
    )
      return false;
    fields.set(field.fieldName, field.value.value);
  }
  return (
    fields.get("decision") === "deny" &&
    fields.get("tool_use_id") === elicitationId
  );
}

/** Only a server-issued ordinary command capability can be declined. */
export async function respondToCommandElicitation(
  ctx: Pick<AdapterContext, "commandDeclines" | "isCurrent" | "readOnly">,
  conversationId: string,
  value: unknown,
): Promise<{ code: string; message: string } | undefined> {
  const refusal = elicitationRefusal(value);
  const v = value as {
    elicitationId?: unknown;
    askNonce?: unknown;
    response?: Record<string, unknown>;
  } | null;
  const response = v?.response;
  const legacyDecline = ordinaryDeclineFields(
    response?.values,
    v?.elicitationId,
  );
  if (
    ctx.readOnly ||
    !ctx.commandDeclines ||
    !response ||
    typeof v?.elicitationId !== "string" ||
    !v.elicitationId ||
    v.elicitationId.length > 512 ||
    !(response.verdict === 2 || (response.verdict === 0 && legacyDecline))
  )
    return refusal;
  // Keep forms, URL/step-up and every persistent/expanded permission fail-closed.
  if (
    (response.approvalOption !== undefined &&
      response.approvalOption !== 0 &&
      response.approvalOption !== 1) ||
    (response.stepUpDecision !== undefined && response.stepUpDecision !== 0) ||
    response.alwaysAllowTools !== undefined ||
    (response.values !== undefined &&
      (!Array.isArray(response.values) ||
        (response.values.length !== 0 && !legacyDecline))) ||
    Object.entries(response).some(
      ([key, val]) =>
        ![
          "verdict",
          "approvalOption",
          "stepUpDecision",
          "values",
          "$typeName",
        ].includes(key) &&
        val !== undefined &&
        val !== null &&
        val !== "" &&
        val !== 0 &&
        val !== false &&
        !(Array.isArray(val) && val.length === 0),
    )
  )
    return {
      code: "unimplemented",
      message:
        "Only an ordinary command decline without other response data is supported.",
    };
  if (
    !conversationId ||
    typeof v?.elicitationId !== "string" ||
    typeof v.askNonce !== "string" ||
    !v.askNonce ||
    v.askNonce.length > 512
  )
    return {
      code: "invalid_argument",
      message: "The command decline requires its original request and nonce.",
    };
  try {
    if (ctx.isCurrent?.() !== true)
      throw new CommandDeclineError(
        "elicitation_unavailable",
        "This account window is no longer active. No decline was sent.",
      );
    await ctx.commandDeclines.decline(
      conversationId,
      v.elicitationId,
      v.askNonce,
    );
    if (ctx.isCurrent?.() !== true)
      throw new Error("Account changed after dispatch");
    return undefined;
  } catch (error) {
    return error instanceof CommandDeclineError
      ? { code: error.code, message: error.message }
      : {
          code: "elicitation_unconfirmed",
          message:
            "The decline result is unconfirmed. It will not be sent again. Reopen the conversation to check its current state.",
        };
  }
}
