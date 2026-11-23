import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { storeOfficialAttachments } from "../../electron/ipc/official-attachments";
import { loadKnowledgeCatalog } from "../../electron/ipc/knowledge";
import { codeEffortInput, codeModelChoice } from "../../electron/ipc/code-model-preferences";
import { cloudCodeSessionKey, isOwnedCloudCoworkSession } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { preference } from "../../shared/settings-extras";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH } from "../../shared/knowledge-api";
import { isEditablePrivateChatProject } from "../../shared/project-access";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { officialCodeFollowupMaxBytes, type OfficialUiReadResponse } from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import type { CallFrame, Dispatcher } from "./dispatcher";
import { finishOfficialAction, readOfficialAction, reserveOfficialAction } from "./official-ui-receipts";
import { findOfficialCoworkDevice } from "./official-cowork-devices";
import { coworkFileAttachments, coworkImageInput, prepareCoworkAttachments } from "./official-cowork-attachments";
import type { WebAppContext } from "./web-app-context";

const creation = z.strictObject({
  message: z.string().max(200_000),
  message_uuid: z.string().uuid(),
  surface: z.literal("hub"),
  model: z.string().min(1).max(200),
  memory_mode: z.enum(["enabled", "disabled"]).optional(),
  effort_level: codeEffortInput.optional(),
  extended_thinking_enabled: z.boolean().optional(),
  title: z.string().max(200).optional(),
  project_uuid: z.string().uuid().optional(),
  no_target_device: z.literal(true).optional(),
  builtin_servers: z.strictObject({ [HIWONDER_KNOWLEDGE_SERVER]: z.boolean().optional() }).optional(),
  target_device_id: z.string().uuid().optional(),
  permission_mode: z.enum(["default", "auto", "bypassPermissions"]).optional(),
  timezone: z.string().regex(/^[A-Za-z0-9_+\-/]{1,128}$/).optional(),
  system_reminders: z.array(z.string().max(4096)).max(1).optional(),
  file_attachments: coworkFileAttachments,
  images: z.array(coworkImageInput).max(12).optional(),
});
const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status, contentType: "application/json", body: Buffer.from(JSON.stringify(value)),
});

export async function createOfficialCoworkSession(
  dispatcher: Dispatcher, frame: CallFrame, ctx: WebAppContext, organization: string,
  request: Record<string, unknown>, activationCurrent: () => boolean, reservation?: { conversationId: string },
): Promise<OfficialUiReadResponse> {
  const owner = ctx.activeAccount?.id;
  if (!owner || !activationCurrent()) return json(409, { error: "The account activation changed." });
  if (organization !== organizationUuid(owner)) return json(404, { error: "Organization not found." });
  if (!(request.body instanceof Uint8Array) || request.body.byteLength > officialCodeFollowupMaxBytes ||
      typeof request.contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(request.contentType))
    return json(400, { error: "Invalid Cowork creation request." });
  let input: z.infer<typeof creation>;
  try {
    input = creation.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)));
    if (!input.message.trim() && !input.file_attachments?.length && !input.images?.length) throw Error();
    const reminder = input.timezone ? new RegExp(`^The user's timezone is ${input.timezone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(currently UTC[+-](?:[0-9]|1[0-4])(?::[0-5][0-9])?\\)\\. Times the user mentions are in this timezone unless they say otherwise\\.$`) : undefined;
    if (input.system_reminders?.some((item) => !reminder?.test(item))) throw Error();
  } catch {
    return json(400, { error: "Unsupported Cowork creation options." });
  }
  const store = ctx.store, identity = ctx.officialSessionIdentity();
  const current = () => activationCurrent() && ctx.store === store && ctx.officialSessionIdentity() === identity;
  const project = input.project_uuid
    ? store.projects.find((row) => row.id === input.project_uuid && isEditablePrivateChatProject(row))
    : undefined;
  if (input.project_uuid && !project) return json(404, { error: "Project not found." });
  const destinationCurrent = () => current() && (!project ||
    (store.projects.includes(project) && isEditablePrivateChatProject(project) && !store.isProjectDeleting(project.id)));
  const permission = input.permission_mode === "bypassPermissions" ? "bypass" : input.permission_mode;
  if (permission && (permission === "bypass"
    ? ctx.runtime?.sandboxDriver !== "runsc" || !preference(store.settings, "allowBypassPermissions")
    : !ctx.policy().permissionModes.includes(permission === "auto" ? "auto" : "manual")))
    return json(403, { error: "This Cowork permission mode is not allowed." });
  if (input.target_device_id && (input.no_target_device || project || permission === "bypass" || !input.message.trim()))
    return json(400, { error: "This Cowork launch option is unavailable on a selected computer." });
  const memoryDisabled = input.memory_mode === "disabled";
  const knowledgeEnabled = input.builtin_servers?.[HIWONDER_KNOWLEDGE_SERVER];
  if (knowledgeEnabled && input.target_device_id)
    return json(400, { error: "Knowledge is unavailable for sessions bound to a computer." });
  if (input.target_device_id && memoryDisabled)
    return json(400, { error: "This Cowork memory choice is unavailable on a selected computer." });
  const provider = store.settings.providers.find((item) => item.id === store.settings.activeProviderId);
  if (!provider || !(provider.model === input.model || provider.models?.includes(input.model) ||
      provider.routes?.some((route) => route.models.includes(input.model))))
    return json(400, { error: "The requested Cowork model is unavailable." });
  try {
    const catalog = await dispatcher.run({ ...frame, method: "modelCatalog", args: [] }, { context: ctx, identity }) as ModelCatalog | null;
    if (!current()) return json(409, { error: "The account activation changed." });
    const matches = catalog?.items.filter((item) => item.id === input.model) ?? [];
    if (matches.length !== 1) throw Error();
    if (input.effort_level) codeModelChoice(matches[0]!, undefined, store.settings.codeEffort, { kind: "effort", value: input.effort_level });
  } catch {
    return json(400, { error: "The requested Cowork model or effort is unavailable." });
  }
  const key = JSON.stringify(["cloud-cowork-create", owner, input.message_uuid.toLowerCase()]);
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  let existing;
  try {
    existing = readOfficialAction(store.root, key, hash);
  } catch {
    return json(409, { error: "This Cowork start could not be confirmed. Check your sessions before retrying." });
  }
  if (existing?.kind === "done") return current() ? existing.answer : json(409, { error: "The account activation changed." });
  if (existing) return json(409, { error: "This Cowork start could not be confirmed. Check your sessions before retrying." });
  let prepared: ReturnType<typeof prepareCoworkAttachments>;
  try {
    prepared = prepareCoworkAttachments(ctx, input.file_attachments ?? [], input.images ?? []);
  } catch {
    return json(400, { error: "A Cowork attachment is unavailable. Select it again." });
  }
  const devicePermission = permission === "auto" ? "auto" : "default";
  let deviceId: string | undefined;
  if (input.target_device_id) {
    try {
      const directory = await ctx.chatDeviceController.directory();
      const device = findOfficialCoworkDevice(directory.devices, owner, input.target_device_id);
      if (!device || !device.chatPermissionModes.includes(devicePermission))
        return json(404, { error: "The selected computer is unavailable." });
      deviceId = device.id;
    } catch {
      return json(503, { error: "The selected computer is unavailable." });
    }
  }
  let stage = "reservation";
  try {
    if (knowledgeEnabled && !(await loadKnowledgeCatalog(ctx)).some(base => base.id === HUANER_TECH && base.available))
      return json(409, { error: "The knowledge base is unavailable." });
    if (!destinationCurrent()) return json(409, { error: "The account or project changed." });
    const receipt = reserveOfficialAction(store.root, key, hash);
    if (receipt.kind === "done") return current() ? receipt.answer : json(409, { error: "The account activation changed." });
    if (receipt.kind !== "reserved") return json(409, { error: "This Cowork start could not be confirmed. Check your sessions before retrying." });
    const attachments = [...prepared.documents, ...storeOfficialAttachments(ctx, prepared.imageFiles)];
    for (const file of prepared.documents) ctx.selectedAttachments.set(file.id, file);
    const conversationId = reservation?.conversationId ?? randomUUID();
    stage = "dispatch";
    if (deviceId) {
      const bound = await ctx.chatDeviceController.send({
        version: 1, accountScope: String(ctx.userId), organizationId: null,
        requestId: input.message_uuid.toLowerCase(), deviceId, conversationId, mode: "cowork",
        providerId: provider.id, model: input.model, text: input.message,
        taskPermission: devicePermission,
        attachments: attachments.map(({ id }) => ({ id })),
        options: {
          effort: input.effort_level,
          thinkingMode: input.extended_thinking_enabled === undefined ? undefined
            : input.extended_thinking_enabled ? "extended" : "standard",
        },
      }, { owner, current: destinationCurrent, title: input.title });
      if (bound.chatDeviceBinding?.deviceId !== deviceId)
        throw Error("The selected computer did not confirm the Cowork binding.");
    } else await dispatcher.run({ ...frame, method: "send", args: encodeWireValue([{
      newConversationId: conversationId, mode: "cowork", providerId: provider.id, model: input.model,
      text: input.message, attachments: attachments.map(({ id }) => ({ id })),
      ...(knowledgeEnabled === undefined ? {} : { connectorOverrides: { [HIWONDER_KNOWLEDGE_SERVER]: knowledgeEnabled } }),
      ...(memoryDisabled ? { memoryDisabled: true } : {}),
      ...(project ? { projectId: project.id } : {}),
      ...(permission ? { coworkPermissionMode: permission } : {}),
      ...(input.effort_level ? { effort: input.effort_level } : {}),
      ...(input.extended_thinking_enabled === undefined ? {} : { thinkingMode: input.extended_thinking_enabled ? "extended" : "standard" }),
      ...(input.timezone ? { sessionInstructions: `The user's timezone is ${input.timezone}. Times the user mentions are in this timezone unless they say otherwise.` } : {}),
    }]) as unknown[] }, { context: ctx, identity, coworkCreation: { conversationId, current: destinationCurrent } });
    if (!current()) return json(409, { error: "The account activation changed." });
    stage = "session lookup";
    const conversation = store.conversations.find((item) => item.id === conversationId && isOwnedCloudCoworkSession(item, owner));
    if (!conversation || conversation.projectId !== project?.id ||
        (conversation.memoryDisabled === true) !== memoryDisabled ||
        (deviceId ? conversation.chatDeviceBinding?.deviceId !== deviceId : conversation.coworkPermissionMode !== permission))
      throw Error("The Cowork session was not confirmed.");
    stage = "opening turn";
    const turn = conversation.turns[0];
    if (!turn || turn.prompt !== input.message || turn.officialCodeEventId !==
        (deviceId ? input.message_uuid.toLowerCase() : undefined))
      throw Error("The Cowork opening turn was not confirmed.");
    turn.officialCodeEventId = input.message_uuid.toLowerCase();
    if (input.title) conversation.title = input.title;
    stage = "history acknowledgement";
    await store.confirmOfficialCodeEvent(conversation, turn.officialCodeEventId, current);
    if (!current() || !store.conversations.includes(conversation)) throw Error("The Cowork session changed.");
    const answer = json(200, { session: {
      id: `session_${cloudCodeSessionKey(conversation, owner)}`,
      config: { model: conversation.model },
      tags: ["cowork-remote"],
      ...(deviceId ? { bound_device_uuid: input.target_device_id } : {}),
    } });
    stage = "receipt acknowledgement";
    finishOfficialAction(receipt.file, hash, answer);
    return answer;
  } catch {
    dispatcher.options.log?.(`Cowork creation stopped at ${stage}.`);
    return json(409, { error: "The Cowork start could not be confirmed. Check your sessions before retrying." });
  }
}
