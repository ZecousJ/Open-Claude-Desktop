import { createHash } from "node:crypto";
import { z } from "zod";
import {
  codeEffortInput,
  codeModelChoice,
} from "../../electron/ipc/code-model-preferences";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { parseSkillReferences, skillReferencesSchema } from "../../shared/skill-references";
import {
  cloudCodeEventId,
  cloudCodeSessionKey,
  isOwnedCloudCoworkSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialCodeControlContentType } from "../../shared/official-code-followup";
import {
  officialCodeFollowupMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import { storeOfficialAttachments } from "../../electron/ipc/official-attachments";
import type { CallFrame, Dispatcher } from "./dispatcher";
import { coworkFileAttachments, coworkMessageContent, prepareCoworkAttachments, readCoworkContent } from "./official-cowork-attachments";
import {
  finishOfficialAction,
  readOfficialAction,
  reserveOfficialAction,
} from "./official-ui-receipts";
import type { WebAppContext } from "./web-app-context";

const modelSetting = z.strictObject({ subtype: z.literal("set_model"), model: z.string().trim().min(1).max(200) });
const effortSetting = z.strictObject({ subtype: z.literal("apply_flag_settings"), settings: z.strictObject({ effortLevel: codeEffortInput }) });
const user = z
  .object({
    type: z.literal("user"),
    uuid: z.string().uuid(),
    session_id: z.string().optional(),
    parent_tool_use_id: z.null().optional(),
    skill_references: skillReferencesSchema.optional(),
    file_attachments: coworkFileAttachments,
    message: z
      .object({
        role: z.literal("user"),
        content: coworkMessageContent,
      })
      .strict(),
  })
  .strict();
const control = z
  .object({
    type: z.literal("control_request"),
    uuid: z.string().uuid().optional(),
    request_id: z.string().min(1).max(200),
    request: z.discriminatedUnion("subtype", [
      effortSetting,
      modelSetting,
      z
        .object({
          subtype: z.literal("set_max_thinking_tokens"),
          max_thinking_tokens: z.union([z.literal(0), z.literal(31999)]),
        })
        .strict(),
      z
        .object({
          subtype: z.literal("initialize"),
          rendersChromeSetupOffer: z.literal(true),
        })
        .strict(),
    ]),
  })
  .strict();
const send = z
  .object({
    session_id: z.string().optional(),
    events: z
      .array(
        z
          .object({
            payload: z.union([user, control]),
            user_declared_urls: z.array(z.string()).max(50).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});
const inFlight = new WeakSet<object>();
const preferences = z.strictObject({
  session_id: z.string().optional(),
  events: z.tuple([z.strictObject({ payload: z.strictObject({
    type: z.literal("control_request"),
    uuid: z.string().uuid().optional(),
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    request: z.discriminatedUnion("subtype", [modelSetting, effortSetting]),
  }) })]),
});
const interrupt = z.strictObject({
  session_id: z.string().optional(),
  events: z.tuple([z.strictObject({
    payload: z.strictObject({
      type: z.literal("control_request"),
      uuid: z.string().uuid().optional(),
      request_id: z.string().regex(/^interrupt-\d+-[a-z0-9]{1,32}$/),
      request: z.strictObject({ subtype: z.literal("interrupt") }),
    }),
  })]),
});

export async function submitOfficialCoworkFollowup(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
): Promise<OfficialUiReadResponse> {
  const account = ctx.activeAccount;
  if (!account || !activationCurrent())
    return json(409, { error: "The account activation changed." });
  if (
    request.codeOrganizationId !== undefined &&
    (typeof request.codeOrganizationId !== "string" ||
      request.codeOrganizationId.toLowerCase() !== organizationUuid(account.id))
  )
    return json(404, { error: "Organization not found." });
  const store = ctx.store,
    identity = ctx.officialSessionIdentity();
  const matches = store.conversations.filter(
    (c) =>
      !c.archived &&
      isOwnedCloudCoworkSession(c, account.id) &&
      cloudCodeSessionKey(c, account.id) === key,
  );
  if (matches.length !== 1)
    return json(404, { error: "Cowork session not found." });
  const conversation = matches[0]!;
  const activation = () => activationCurrent() && ctx.store === store &&
    ctx.officialSessionIdentity() === identity;
  const binding = conversation.chatDeviceBinding;
  const current = () => activation() && store.conversations.includes(conversation) &&
    !conversation.archived && isOwnedCloudCoworkSession(conversation, account.id);
  const belongs = (id: string | undefined) => id === undefined || id === `session_${key}` || id === `cse_${key}`;
  const modelChoice = async (model: string, effort?: z.infer<typeof codeEffortInput>) => {
    const catalog = await dispatcher.run({ ...frame, method: "modelCatalog", args: [] }, { context: ctx, identity }) as ModelCatalog | null;
    const provider = store.settings.providers.find(item => item.id === conversation.providerId);
    const [item, duplicate] = catalog?.items.filter(candidate => candidate.id === model) ?? [];
    if (!current() || !item || duplicate || !provider || ![provider.model, ...(provider.models ?? []), ...(provider.routes ?? []).flatMap(route => route.models)].includes(model))
      throw Error("The Cowork model is unavailable.");
    return codeModelChoice(item, conversation.effort, store.settings.codeEffort,
      effort === undefined ? { kind: "model" } : { kind: "effort", value: effort });
  };
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > officialCodeFollowupMaxBytes ||
    typeof request.contentType !== "string" ||
    !/^application\/json(?:\s*;.*)?$/i.test(request.contentType)
  )
    return json(400, { error: "Invalid Cowork message." });
  let input: z.infer<typeof send>;
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body));
    const preference = preferences.safeParse(body);
    if (preference.success) {
      if (!belongs(preference.data.session_id)) return json(400, { error: "Invalid Cowork session." });
      if (binding || inFlight.has(conversation)) return json(409, { error: "This Cowork session can't change its model settings right now." });
      const { request: choice, request_id } = preference.data.events[0].payload;
      const previous = { model: conversation.model, effort: conversation.effort };
      inFlight.add(conversation);
      try {
        const patch = choice.subtype === "set_model" ? await modelChoice(choice.model) :
          await modelChoice(previous.model, choice.settings.effortLevel);
        const changed = await store.commitCoworkModelPreference(conversation, patch, () => current() &&
          conversation.model === previous.model && conversation.effort === previous.effort);
        if (!current()) return json(409, { error: "The Cowork session changed." });
        if (changed) ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
        return { ...json(200, { requestId: request_id, response: {}, persisted: true }), contentType: officialCodeControlContentType };
      } catch {
        return json(409, { error: "The Cowork model settings could not be saved." });
      } finally {
        inFlight.delete(conversation);
      }
    }
    const stop = interrupt.safeParse(body);
    if (stop.success && binding) {
      if (stop.data.session_id && ![`session_${key}`, `cse_${key}`].includes(stop.data.session_id))
        return json(400, { error: "Invalid Cowork session." });
      const turn = conversation.turns.at(-1);
      if (turn?.status === "inProgress") {
        if (turn.id.startsWith("pending-") || !current())
          return json(409, { error: "The Cowork stop target is not available yet." });
        try {
          const result = await dispatcher.run({
            ...frame, method: "interrupt", args: [conversation.id, {
              turnId: turn.id, turnCreatedAt: turn.createdAt, conversationCreatedAt: conversation.createdAt,
            }],
          }, { context: ctx, identity });
          if (!activation() || (result as { status?: string } | undefined)?.status === "mismatch")
            return json(409, { error: "The Cowork turn changed before Stop." });
        } catch {
          return json(409, { error: "The Cowork stop could not be confirmed." });
        }
      }
      return json(200, { events: [] });
    }
    input = send.parse(body);
  } catch {
    return json(400, { error: "Invalid Cowork message or attachments." });
  }
  const events = input.events.map((entry) => entry.payload);
  const event = events.at(-1);
  if (
    !event ||
    event.type !== "user" ||
    events.slice(0, -1).some((e) => e.type !== "control_request")
  )
    return json(400, { error: "Send one Cowork message at a time." });
  const controls = events
    .slice(0, -1)
    .filter((e): e is z.infer<typeof control> => e.type === "control_request");
  if (
    new Set(controls.map((e) => e.request.subtype)).size !== controls.length ||
    new Set(controls.map((e) => e.request_id)).size !== controls.length
  )
    return json(400, { error: "Duplicate Cowork settings are not supported." });
  const effortControl = controls.find(
    (e) => e.request.subtype === "apply_flag_settings",
  )?.request;
  const modelControl = controls.find(e => e.request.subtype === "set_model")?.request;
  const thinkingControl = controls.find(
    (e) => e.request.subtype === "set_max_thinking_tokens",
  )?.request;
  let effort: z.infer<typeof codeEffortInput> | undefined;
  const model = modelControl?.subtype === "set_model" ? modelControl.model : conversation.model;
  if (binding && model !== conversation.model) return json(409, { error: "This computer cannot change the Cowork model." });
  if (effortControl?.subtype === "apply_flag_settings" || modelControl) {
    try {
      effort = (await modelChoice(model, effortControl?.subtype === "apply_flag_settings" ? effortControl.settings.effortLevel : undefined)).effort;
    } catch {
      return json(409, {
        error: "The Cowork model or reasoning effort is unavailable.",
      });
    }
  }
  const thinkingMode =
    thinkingControl?.subtype === "set_max_thinking_tokens"
      ? thinkingControl.max_thinking_tokens === 0
        ? ("standard" as const)
        : ("extended" as const)
      : undefined;
  const { message, images } = readCoworkContent(event.message.content);
  const referencedFiles = event.file_attachments ?? [];
  const hasAttachments = images.length + referencedFiles.length > 0;
  if (
    !belongs(input.session_id) ||
    !belongs(event.session_id) ||
    (!message.trim() && !hasAttachments) ||
    message.length > 200_000
  )
    return json(400, { error: "Invalid Cowork message." });
  let skillReferences;
  try {
    skillReferences = parseSkillReferences(message, event.skill_references ?? []);
  } catch {
    return json(400, { error: "A selected skill no longer matches the message. Select it again." });
  }
  if (binding && skillReferences.length)
    return json(400, { error: "Selected skills are unavailable on this computer." });
  const eventId = event.uuid.toLowerCase();
  const opening = conversation.turns[0];
  if (opening?.officialCodeEventId === eventId) {
    return opening.prompt === message && controls.length === 0
      ? json(200, { events: [{ event_id: cloudCodeEventId(`session_${key}`, eventId) }] })
      : json(409, { error: "This Cowork event ID belongs to another message." });
  }
  const actionKey = JSON.stringify([
    "cloud-cowork-followup",
    account.id,
    conversation.id,
    conversation.createdAt,
    eventId,
  ]);
  const hash = createHash("sha256")
    .update(JSON.stringify([message, effort ?? null, thinkingMode ?? null,
      ...(modelControl ? [{ model }] : []),
      ...(skillReferences.length ? [skillReferences] : []),
      ...(hasAttachments ? [{ images, files: referencedFiles.map(file => file.file_uuid.toLowerCase()) }] : [])]))
    .digest("hex");
  const answer = json(200, {
    events: [{ event_id: cloudCodeEventId(`session_${key}`, eventId) }],
  });
  try {
    const existing = readOfficialAction(store.root, actionKey, hash);
    if (existing?.kind === "done")
      return current()
        ? existing.answer
        : json(409, { error: "The account activation changed." });
    if (existing?.kind === "conflict")
      return json(409, {
        error: "This Cowork event ID belongs to another message.",
      });
    if (existing?.kind === "pending")
      return json(409, {
        error:
          "The previous Cowork send could not be confirmed. Reopen the session.",
      });
  } catch {
    return json(409, {
      error: "The Cowork send could not be confirmed. Reopen the session.",
    });
  }
  if (
    inFlight.has(conversation) ||
    conversation.turns.some((turn) => turn.status === "inProgress")
  )
    return json(409, { error: "Wait for the current Cowork turn to finish." });
  let prepared: ReturnType<typeof prepareCoworkAttachments>;
  try {
    prepared = prepareCoworkAttachments(ctx, referencedFiles, images);
  } catch {
    return json(400, { error: "A Cowork attachment is unavailable. Select it again." });
  }
  inFlight.add(conversation);
  try {
    const receipt = reserveOfficialAction(store.root, actionKey, hash);
    if (receipt.kind === "done")
      return current()
        ? receipt.answer
        : json(409, { error: "The account activation changed." });
    if (receipt.kind === "conflict")
      return json(409, {
        error: "This Cowork event ID belongs to another message.",
      });
    if (receipt.kind !== "reserved" || !current())
      return json(409, {
        error:
          "The previous Cowork send could not be confirmed. Reopen the session.",
      });
    const attachments = [...prepared.documents, ...storeOfficialAttachments(ctx, prepared.imageFiles)]
      .map(({ id }) => ({ id }));
    if (binding) {
      const updated = await ctx.chatDeviceController.send({
        version: 1, accountScope: String(ctx.userId), organizationId: null,
        requestId: eventId, deviceId: binding.deviceId,
        expectedBindingRevision: binding.revision, conversationId: conversation.id,
        mode: "cowork", providerId: conversation.providerId, model: conversation.model,
        text: message, taskPermission: binding.permission, attachments,
        options: { effort, thinkingMode },
      }, { owner: account.id, current: activation });
      const bound = () => activation() && store.conversations.includes(updated) &&
        updated.chatDeviceBinding?.deviceId === binding.deviceId &&
        updated.chatDeviceBinding?.revision === binding.revision &&
        isOwnedCloudCoworkSession(updated, account.id);
      await store.confirmOfficialCodeEvent(updated, eventId, bound);
      if (!bound()) throw Error("The Cowork binding changed.");
    } else await dispatcher.run(
      {
        ...frame,
        method: "send",
        args: encodeWireValue([
          {
            conversationId: conversation.id,
            mode: "cowork",
            providerId: conversation.providerId,
            model,
            text: message,
            ...(skillReferences.length ? { skillReferences } : {}),
            attachments,
            ...(effort === undefined ? {} : { effort }),
            ...(thinkingMode === undefined ? {} : { thinkingMode }),
          },
        ]) as unknown[],
      },
      {
        context: ctx,
        identity,
        coworkFollowup: { conversationId: conversation.id, current },
      },
    );
    if (!(binding ? activation() : current()))
      return json(409, {
        error: "The Cowork send could not be confirmed. Reopen the session.",
      });
    finishOfficialAction(receipt.file, hash, answer);
    return answer;
  } catch {
    return json(409, {
      error: "The Cowork send could not be confirmed. Reopen the session.",
    });
  } finally {
    inFlight.delete(conversation);
  }
}
