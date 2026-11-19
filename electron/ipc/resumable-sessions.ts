import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Conversation } from "../../shared/types";
import { CliResumeError } from "../../shared/resume-sessions";
import { ResumeSessions, resumeTurns } from "../engine/resume-sessions";
import type { Context, Handle } from "./conversations";

const opaqueHandle = z.string().uuid();

export function registerResumableSessions(handle: Handle, context: Context) {
  const scope = () => context.accountGeneration?.() ?? context.store;
  const capture = () => {
    const store = context.store;
    const root = store.root;
    const generation = scope();
    return {
      store,
      current: () =>
        !context.accountRetiring &&
        context.store === store &&
        context.store.root === root &&
        scope() === generation,
    };
  };
  const allowFolder = (cwd: string) => {
    context.allowedFolder(cwd);
    context.services?.workspaceTrust?.assert({ mode: "code", cwd });
  };
  const options = {
    scope,
    allowFolder,
    conversations: () => context.store.conversations,
  };
  const native = new ResumeSessions({
    ...options,
    request: (method, params) =>
      context.engine.resumeSessionRequest(method, params),
  });
  const candidate = async (id: string, resume: boolean) => {
    const thread = await native.read(id, resume);
    return {
      threadId: thread.id,
      title: thread.name || thread.preview,
      cwd: thread.cwd,
      turns: resumeTurns(thread),
      codePermissionMode: undefined,
      createdAt: thread.createdAt * 1000,
      updatedAt: thread.updatedAt * 1000,
    };
  };
  const existing = (id: string) => {
    const saved = native.existing(id);
    const owner = context.activeAccount?.id;
    return saved?.mode === "code" &&
      !saved.incognito &&
      !saved.cloudHosted &&
      !saved.cloudEnvironmentId &&
      (!saved.sessionAuthors ||
        (saved.sessionAuthors.ownerAccountUuid === owner &&
          saved.sessionAuthors.viewerAccountUuid === owner))
      ? saved
      : undefined;
  };
  const providerFor = (store: Context["store"]) =>
    store.settings.providers.find(
      (entry) => entry.id === store.settings.activeProviderId,
    );
  const save = (
    entry: Awaited<ReturnType<typeof candidate>>,
    { store, current }: ReturnType<typeof capture>,
  ) => {
    if (!current())
      throw Error("The account changed during Code session import.");
    const provider = providerFor(store);
    if (!provider) throw Error("Couldn’t resume that session.");
    const owner = context.activeAccount?.id;
    const conversation: Conversation = {
      ...entry,
      id: randomUUID(),
      title: entry.title || "Untitled session",
      mode: "code",
      providerId: provider.id,
      model: provider.model,
      environment: context.engine.environment,
      pinned: false,
      archived: false,
      ...(owner && {
        sessionAuthors: { ownerAccountUuid: owner, viewerAccountUuid: owner },
      }),
    };
    if (conversation.environment?.kind === "space") {
      store.conversations.unshift(conversation);
      try {
        store.flush();
      } catch (error) {
        store.conversations.splice(
          store.conversations.indexOf(conversation),
          1,
        );
        throw error;
      }
    } else {
      store.commitImportedConversations([conversation], current);
    }
    context.push?.({
      type: "conversation",
      conversation: structuredClone(conversation),
    });
    return conversation;
  };

  handle("listResumableSessions", () => native.list());
  handle("probeImportableCliSessions", () => ({ count: 0 }));
  handle("importAllCliSessions", () => ({ imported: 0, skipped: 0 }));
  handle(
    "previewResumeSession",
    async (raw: unknown) =>
      (await candidate(opaqueHandle.parse(raw), false)).turns,
  );
  handle("inspectResumableSession", async (raw: unknown) => {
    const id = opaqueHandle.parse(raw);
    const entry = existing(id) ?? (await candidate(id, true));
    if ("archived" in entry && entry.archived)
      throw new CliResumeError("failed", "Couldn’t resume that session.");
    return {
      permissionMode:
        entry.codePermissionMode === "manual"
          ? "default"
          : entry.codePermissionMode,
      model: "model" in entry ? entry.model : providerFor(context.store)?.model,
    };
  });
  handle("resumeSession", async (raw: unknown) => {
    const id = opaqueHandle.parse(raw);
    const lease = capture();
    const saved = existing(id);
    if (saved && !saved.archived) return saved;
    try {
      const entry = await candidate(id, true);
      if (!lease.current())
        throw Error("The account changed during Code session import.");
      return existing(id) ?? save(entry, lease);
    } catch (error) {
      const saved = lease.current() && existing(id);
      if (saved && !saved.archived) return saved;
      throw error;
    }
  });
}
