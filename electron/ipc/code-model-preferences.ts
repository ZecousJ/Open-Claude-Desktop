import type { CodeEffort, Conversation, Settings } from "../../shared/types";
import {
  isConversationModel,
  type ModelCatalogItem,
} from "../../shared/model-catalog-api";
import { validGatewayEfforts } from "../../shared/gateway-signals";
import { CodeUltracodeUnavailable, supportsCodeUltracode } from "../../shared/code-session-settings";
import type { Context } from "./conversations";
import { z } from "zod";

export type CodeModelPreference = Pick<
  Partial<Conversation>,
  "providerId" | "model" | "effort" | "codeUltracode"
>;

export function codeStartProvider({ providers, activeProviderId }: Pick<Settings, "providers" | "activeProviderId">) {
  return providers.find((provider) => provider.id === activeProviderId) ??
    providers.find((provider) => provider.backend === "sub2api") ??
    providers[0];
}

export const codeEffortInput = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export function codeModelChoice(
  item: ModelCatalogItem,
  previous: CodeEffort | undefined,
  fallback: CodeEffort,
  selection: { kind: "model" } | { kind: "effort"; value: string | null },
): { model?: string; effort?: CodeEffort } {
  const efforts = item.efforts ?? [];
  if (!validGatewayEfforts(efforts))
    throw Error("The model's reasoning capabilities are unavailable.");
  const supported = (value: unknown): value is CodeEffort =>
    codeEffortInput.safeParse(value).success &&
    efforts.some((effort) => effort === value);
  if (selection.kind === "model") {
    const effort = [previous, item.defaultEffort, fallback, ...efforts].find(
      supported,
    );
    if (efforts.length && !effort)
      throw Error(
        "This model's reasoning settings are not supported by Code yet.",
      );
    return { model: item.id, ...(effort ? { effort } : {}) };
  }
  const effort =
    selection.value === null
      ? [item.defaultEffort, fallback, ...efforts].find(supported)
      : selection.value;
  if (!codeEffortInput.safeParse(effort).success)
    throw Error("This reasoning effort is not supported.");
  if (!supported(effort))
    throw Error(
      "This reasoning effort is not supported by the selected model.",
    );
  return { effort };
}

/** Existing handlers reject an object model instead of silently ignoring a new flag. */
export function readCodeModelPreference(
  raw: unknown,
  conversation: Conversation,
): CodeModelPreference {
  const identifier = z.string().trim().min(1).max(200);
  const { model: envelope } = z
    .object({
      model: z
        .object({
          version: z.literal(1),
          expected: z
            .object({
              providerId: identifier,
              model: identifier,
              effort: codeEffortInput.nullable(),
              codeUltracode: z.boolean().optional(),
            })
            .strict(),
          choice: z
            .object({
              model: identifier.optional(),
              effort: codeEffortInput.optional(),
              codeUltracode: z.boolean().optional(),
            })
            .strict()
            .refine(
              (value) =>
                value.model !== undefined || value.effort !== undefined ||
                value.codeUltracode !== undefined,
            ),
        })
        .strict(),
    })
    .strict()
    .parse(raw);
  if (
    conversation.mode !== "code" ||
    conversation.incognito ||
    conversation.providerId !== envelope.expected.providerId ||
    conversation.model !== envelope.expected.model ||
    (conversation.effort ?? null) !== envelope.expected.effort ||
    (envelope.expected.codeUltracode !== undefined &&
      (conversation.codeUltracode ?? false) !== envelope.expected.codeUltracode)
  )
    throw Error("The Code model changed. Reopen its settings before retrying.");
  return {
    ...envelope.choice,
    ...(envelope.choice.model === undefined
      ? {}
      : { providerId: conversation.providerId }),
  };
}

/** Save the next-turn choice without changing a running turn or global defaults. */
export async function saveCodeModelPreference(
  context: Pick<
    Context,
    "store" | "engine" | "accountGeneration" | "accountRetiring" | "push"
  >,
  conversation: Conversation,
  patch: CodeModelPreference,
  callerCurrent?: () => boolean,
) {
  const store = context.store,
    engine = context.engine;
  const generation = context.accountGeneration?.();
  const current = () =>
    !context.accountRetiring &&
    callerCurrent?.() !== false &&
    context.store === store &&
    context.engine === engine &&
    context.accountGeneration?.() === generation &&
    store.conversations.filter((row) => row.id === conversation.id).length ===
      1 &&
    store.conversations.includes(conversation);
  if (!context.accountGeneration || generation == null || !current())
    throw Error(
      "Account-scoped Code model updates are unavailable on this host.",
    );
  if (conversation.mode !== "code" || conversation.incognito)
    throw Error("Only a Code session's model settings can be changed.");
  const providerId = patch.providerId ?? conversation.providerId;
  const model = patch.model ?? conversation.model;
  const provider = store.settings.providers.find(
    (row) => row.id === providerId,
  );
  if (!provider) throw Error("This model service isn't available.");
  if (
    (patch.model !== undefined && !isConversationModel(model)) ||
    (provider.models.length &&
      !new Set([provider.model, ...provider.models]).has(model))
  )
    throw Error("This account cannot use the selected model.");
  const offered = engine.modelEfforts(providerId, model);
  if (offered !== undefined && !validGatewayEfforts(offered))
    throw Error("The model's reasoning capabilities are unavailable.");
  if (patch.effort !== undefined && offered && !offered.includes(patch.effort))
    throw Error(
      "This reasoning effort is not supported by the selected model.",
    );
  const next = { ...patch };
  const previousUltracode = conversation.codeUltracode;
  const previous = {
    providerId: conversation.providerId,
    model: conversation.model,
    effort: conversation.effort,
    threadId: conversation.threadId,
  };
  const previousCurrent = () => current() &&
    conversation.codeUltracode === previousUltracode &&
    conversation.providerId === previous.providerId &&
    conversation.model === previous.model &&
    conversation.effort === previous.effort &&
    conversation.threadId === previous.threadId;
  if (patch.codeUltracode === true && (
    conversation.environment?.kind === "ssh" ||
    conversation.environment?.kind === "wsl" ||
    !engine.codeUltracodeAvailable(providerId, model) ||
    !await engine.codeUltracodeThreadAvailable(conversation) ||
    !engine.codeUltracodeAvailable(providerId, model)
  ))
    throw new CodeUltracodeUnavailable();
  if (previousUltracode && patch.model !== undefined && model !== conversation.model &&
      !supportsCodeUltracode(offered))
    next.codeUltracode = false;
  if (patch.model !== undefined && offered) {
    if (!offered.length) next.effort = undefined;
    else if (
      patch.effort === undefined &&
      !offered.includes(conversation.effort ?? store.settings.codeEffort)
    ) {
      const fallback = offered.find((value) =>
        ["low", "medium", "high", "xhigh", "max", "ultra"].includes(value),
      );
      if (!fallback)
        throw Error(
          "This model's reasoning settings are not supported by Code yet.",
        );
      next.effort = fallback as Conversation["effort"];
    }
  }
  const measured = conversation.tokenUsage;
  const patchToSave = next.model !== undefined && next.model !== conversation.model &&
    measured && measured.model === undefined
    ? { ...next, tokenUsage: { ...measured, model: conversation.model } }
    : next;
  await store.persistChatMetadata(conversation, patchToSave,
    next.codeUltracode === undefined ? current : previousCurrent,
  );
  if (
    !current() ||
    Object.entries(next).some(
      ([key, value]) => (conversation as any)[key] !== value,
    )
  )
    throw Error(
      "The Code model save could not be confirmed. Reopen before retrying.",
    );
  const saved = structuredClone(conversation);
  context.push?.({ type: "conversation", conversation: saved });
  return saved;
}
