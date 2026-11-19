import type http from "node:http";
import { z } from "zod";
import { isOfficialUiConversationCreation } from "../../../shared/official-ui-web";
import type { Conversation, Provider } from "../../../shared/types";
import { newConversation } from "../../engine/new-conversation";
import type { Store } from "../../store/store";
import { conversationRow } from "./conversations";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { scopedValue } from "./scope";

export interface EmptyChatInput {
  id: string;
  title: string;
  model: string;
  provider: Provider;
  memoryDisabled: boolean;
  projectId?: string;
}

class ChatCreationConflict extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message);
  }
}

export async function persistEmptyChat(
  input: EmptyChatInput,
  store: Store,
  current: () => boolean,
  workspace: () => { cwd: string; environment?: Conversation["environment"] },
  changed: (conversation: Conversation) => void,
): Promise<Conversation> {
  if (!current()) throw new ChatCreationConflict("The account changed.");
  const hasProject = () => {
    if (!input.projectId) return true;
    const projects = store.projects.filter(project => project.id === input.projectId);
    return projects.length === 1 && !store.isProjectDeleting(input.projectId) && (projects[0].kind ?? "chat") === "chat";
  };
  if (!hasProject()) throw new ChatCreationConflict("Project not found.", 404);
  const existing = store.conversations.find((conversation) => conversation.id === input.id);
  if (existing && (existing.mode !== "chat" || existing.incognito ||
      existing.title !== input.title || existing.model !== input.model ||
      existing.projectId !== input.projectId ||
      existing.providerId !== input.provider.id || !!existing.memoryDisabled !== input.memoryDisabled))
    throw new ChatCreationConflict("That conversation already exists.");
  const conversation = existing ?? (() => {
    const { cwd, environment } = workspace();
    return {
      ...newConversation({
        newConversationId: input.id,
        mode: "chat",
        text: "",
        attachments: [],
        providerId: input.provider.id,
        model: input.model,
        projectId: input.projectId,
        memoryDisabled: input.memoryDisabled ? true : undefined,
      }, input.provider, cwd, store.settings),
      title: input.title,
      titleSetByUser: !!input.title,
      ...(environment ? { environment } : {}),
    };
  })();
  if (!existing) store.conversations.unshift(conversation);
  store.flush();
  const stillBound = () => hasProject() && conversation.projectId === input.projectId;
  await store.confirmConversationMetadata(conversation, () => current() && stillBound(), true);
  if (!current()) throw new ChatCreationConflict("The account changed.");
  if (!stillBound()) throw new ChatCreationConflict("The conversation's project changed.");
  if (!existing) changed(conversation);
  return conversation;
}

const creation = z.object({
  uuid: z.string().uuid(),
  name: z.string().max(512),
  model: z.string().min(1).max(256),
  compass_mode: z.null().optional(),
  chat_memory_mode: z.enum(["enabled", "disabled"]).optional(),
  project_uuid: z.string().uuid().nullable().optional(),
  is_temporary: z.literal(false).optional(),
}).strict();

export async function emptyChatRoute(
  req: http.IncomingMessage, res: http.ServerResponse, path: string, url: URL, ctx: AdapterContext,
) {
  if (!isOfficialUiConversationCreation(req.method ?? "", path)) return false;
  const owner = ctx.account()?.id, identity = ctx.sessionIdentity?.();
  if (!owner || path.split("/")[3] !== organizationUuid(owner))
    return reply(res, { error: "Organization not found." }, 404);
  if (!ctx.createEmptyChat)
    return reply(res, { error: "Independent Chat creation is unavailable on this host." }, 501);
  if (url.search)
    return reply(res, { error: "Chat creation query parameters are unsupported." }, 400);
  const current = () => ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity && ctx.isCurrent?.() !== false;
  const queue = scopedValue("empty-chat-save", () => ({ tail: Promise.resolve() }));
  try {
    const parsed = creation.safeParse(await readBoundedJson(req, 4096));
    if (!parsed.success) return reply(res, { error: "Unsupported Chat creation options." }, 400);
    const { uuid, name, model, chat_memory_mode, project_uuid } = parsed.data;
    const save = queue.tail.then(async () => {
      if (!current()) throw new ChatCreationConflict("The account changed.");
      const catalog = await ctx.modelCatalog();
      if (!current()) throw new ChatCreationConflict("The account changed.");
      const settings = ctx.settings();
      const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
      if (catalog?.items.filter((item) => item.id === model).length !== 1 ||
          !provider || !(provider.model === model || provider.models?.includes(model) ||
            provider.routes?.some((route) => route.models.includes(model))))
        return reply(res, { error: "The requested Chat model is unavailable." }, 400);
      const conversation = await ctx.createEmptyChat!({
        id: uuid, title: name, model, provider, memoryDisabled: chat_memory_mode === "disabled",
        projectId: project_uuid ?? undefined,
      });
      if (!current()) throw new ChatCreationConflict("The account changed.");
      return reply(res, conversationRow(conversation));
    });
    queue.tail = save.then(() => {}, () => {});
    return await save;
  } catch (error) {
    if (!current()) return reply(res, { error: "The account changed." }, 409);
    if (error instanceof RequestBodyError || error instanceof ChatCreationConflict)
      return reply(res, { error: error.message }, error.status);
    return reply(res, { error: "Chat creation could not be confirmed. Reopen it before sending." }, 503);
  }
}
