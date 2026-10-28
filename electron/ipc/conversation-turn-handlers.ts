import { z } from "zod";
import type { Conversation } from "../../shared/types";
import { randomUUID } from "node:crypto";
import { resumeTurns } from "../engine/resume-sessions";
import { registryOf } from "../engine/engine-registry";
import { isSetupHook } from "../../shared/session-setup";
import { scheduledTaskSetupInput } from "../routines/scheduled-task-setup";
import {
  connectorOverridesInput,
  connectorToolOverridesInput,
} from "../../shared/project-tools-input";
import { string, environmentInput } from "./conversations";
import { sameEnvironment } from "../engine/engine-types";
import {
  coworkFolderGrants,
  assertCoworkFolder,
} from "../workspace/cowork-folders";
import { projectFolders } from "../../shared/project-folders";
import type { CliSessions } from "../conversations/cli-sessions";
import type { Context, Handle } from "./conversations";
import type { ResumeSessions } from "../engine/resume-sessions";

/** What registerConversationTurnHandlers needs from conversations.ts. */
export interface RegisterConversationTurnHandlersKit {
  cli: CliSessions;
  context: Context;
  handle: Handle;
  importCli: (handle: string) => Promise<Conversation>;
  resumable: ResumeSessions;
}

export function registerConversationTurnHandlers(
  kit: RegisterConversationTurnHandlersKit,
) {
  const { cli, context, handle, importCli, resumable } = kit;
  let resuming = false;
  handle("resumeSession", async (raw: unknown) => {
    if (resuming) throw new Error("Couldn’t resume that session.");
    resuming = true;
    try {
      const handle = z.string().uuid().parse(raw);
      if (cli.owns(handle)) return await importCli(handle);
      const thread = await resumable.read(z.string().uuid().parse(raw), true);
      const settings = context.store.settings;
      const provider = settings.providers.find(
        (entry) => entry.id === settings.activeProviderId,
      )!;
      const conversation: Conversation = {
        id: randomUUID(),
        threadId: thread.id,
        title: thread.name || thread.preview || "Untitled session",
        mode: "code",
        cwd: thread.cwd,
        providerId: provider.id,
        model: provider.model,
        environment: context.engine.environment,
        pinned: false,
        archived: false,
        createdAt: thread.createdAt * 1000,
        updatedAt: thread.updatedAt * 1000,
        turns: resumeTurns(thread),
      };
      context.store.conversations.unshift(conversation);
      context.store.flush();
      context.push?.({
        type: "conversation",
        conversation: structuredClone(conversation),
      });
      return conversation;
    } finally {
      resuming = false;
    }
  });
  /**
   * The engine running a stored conversation now (R9: an SSH host's for a
   * conversation there), for direct use of its runtime (thread/archive).
   * It never starts or creates an engine: deleting a conversation whose host
   * isn't connected (or no longer exists) still works, and its threads stay
   * on that host.
   */
  const engineOf = (conversationId: string) => {
    const registry = registryOf(context.engine);
    return registry ? registry.running(conversationId) : context.engine;
  };
  handle("send", async (raw: any, extra?: { setup?: unknown }) => {
    // A cloud session's setup (runner/src/dispatcher.ts). A window's
    // arguments are cloned data, so they never carry one.
    const candidate = extra?.setup;
    const setup = isSetupHook(candidate) ? candidate : undefined;
    const input = z
      .object({
        conversationId: z.string().optional(),
        scheduledTaskSetup: scheduledTaskSetupInput.optional(),
        blankArtifactRevision: z
          .object({
            artifactId: z.string().uuid(),
            revision: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
        text: z.string().max(200000),
        mode: z.enum(["chat", "cowork", "code"]),
        artifactOutputKind: z
          .enum(["docs", "slides", "design", "dashboard"])
          .optional(),
        codePermissionMode: z
          .enum(["auto", "manual", "acceptEdits", "plan", "bypass"])
          .optional(),
        taskPermission: z.enum(["default", "auto", "bypass"]).optional(),
        webSearch: z.boolean().optional(),
        thinkingSummariesWanted: z.boolean().optional(),
        thinkingMode: z.enum(["standard", "extended"]).optional(),
        connectorOverrides: connectorOverridesInput.optional(),
        connectorToolOverrides: connectorToolOverridesInput.optional(),
        toolSearchMode: z.enum(["on", "off"]).optional(),
        research: z.boolean().optional(),
        projectId: z.string().optional(),
        cwd: z.string().optional(),
        additionalFolders: z
          .array(z.string().min(1).max(4096))
          .max(20)
          .optional(),
        attachments: z.array(z.object({ id: z.string() })).max(12),
        providerId: string,
        model: z.string().max(200),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
          .optional(),
        incognito: z.boolean().optional(),
        environment: environmentInput.optional(),
        asksFirst: z.boolean().optional(),
        worktree: z.boolean().optional(),
        worktreeBranch: z.string().min(1).max(255).optional(),
        autoPullRequest: z.enum(["ready", "draft"]).optional(),
        cloudEnvironmentId: z.string().max(100).optional(),
      })
      .parse(raw);
    const existing = input.conversationId
      ? context.store.conversation(input.conversationId)
      : undefined;
    if (
      input.scheduledTaskSetup &&
      (existing || input.mode === "code" || input.incognito)
    )
      throw new Error(
        "Scheduled task setup belongs to a new non-incognito Chat.",
      );
    if (input.artifactOutputKind && (existing || input.mode !== "code"))
      throw Error("An output template belongs to a new Code session.");
    if (input.codePermissionMode && (existing || input.mode !== "code"))
      throw Error("A session permission choice belongs to a new Code session.");
    if (input.additionalFolders !== undefined) {
      if (input.mode !== "code" || existing)
        throw Error("Only new Code sessions can choose initial folders.");
      input.additionalFolders = [...new Set(input.additionalFolders)].filter(
        (folder) => folder !== input.cwd,
      );
    }
    // A conversation keeps the environment it started in.
    const environment = existing ? existing.environment : input.environment;
    if (
      existing &&
      input.environment &&
      !sameEnvironment(existing.environment, input.environment)
    )
      throw new Error("This conversation runs somewhere else.");
    if (environment?.kind === "ssh") {
      // R9: Code conversations on an SSH host, in a folder chosen there.
      if (input.mode !== "code" || (existing && existing.mode !== "code"))
        throw new Error("SSH connections are only for Code.");
      if (input.incognito)
        throw new Error("SSH conversations can't be incognito.");
      const registry = registryOf(context.engine);
      if (!registry) throw new Error("SSH connections aren't available.");
      registry.allowedFolder(input.cwd ?? existing?.cwd, environment);
      for (const folder of input.additionalFolders ?? [])
        registry.allowedFolder(folder, environment);
      const attachments = input.attachments.map((a) => {
        const known = context.selectedAttachments.get(a.id);
        if (!known)
          throw new Error(
            "This attachment is no longer available. Add it again.",
          );
        return known;
      });
      return context.engine.send({
        ...input,
        ...(existing ? {} : { environment }),
        ...(existing ? { cwd: existing.cwd } : {}),
        attachments,
      });
    }
    context.allowedFolder(input.cwd);
    for (const folder of input.additionalFolders ?? [])
      context.allowedFolder(folder);
    // Cowork uses a folder of the person's only after they allowed it (R11).
    const grants = coworkFolderGrants(context.store.root);
    const project = context.store.projects.find(
      (p) => p.id === input.projectId,
    );
    const projectOnly =
      (existing?.mode ?? input.mode) !== "code" &&
      (existing?.incognito ?? input.incognito);
    const workingFolder = input.cwd ?? (projectOnly ? undefined : project?.cwd);
    const folder = assertCoworkFolder(grants, {
      mode: input.mode,
      conversation: existing,
      cwd: workingFolder,
      // Folders the person allowed for the project pass for its new tasks.
      ...(existing || !project ? {} : { projectId: project.id }),
    });
    // Code runs only in a folder Codex trusts ("Trust this workspace?").
    context.services?.workspaceTrust?.assert({
      mode: input.mode,
      conversation: existing,
      cwd: workingFolder,
    });
    const attachments = input.attachments.map((a) => {
      const known = context.selectedAttachments.get(a.id);
      if (!known)
        throw new Error(
          "This attachment is no longer available. Add it again.",
        );
      return known;
    });
    // A new task starts in the folder's real path, the one that was allowed.
    const conversation = await context.engine.send({
      ...input,
      ...(folder ? { cwd: folder } : {}),
      attachments,
      ...(setup && input.mode === "code" ? { setup } : {}),
    });
    if (folder) grants.bind(conversation, folder);
    // A new Cowork task in a project gets the project's other folders.
    if (!existing && project && conversation.mode === "cowork") {
      const working = input.cwd ?? project.cwd;
      const others = projectFolders(project).filter(
        (path) => path !== working && path !== folder,
      );
      if (
        others.length &&
        grants.bindProjectFolders(conversation, project.id, others).length
      )
        context.push?.({
          type: "cowork-folders",
          conversationId: conversation.id,
        });
    }
    return conversation;
  });
  /** Edits and retries run in the task's folder again: it must still be allowed. */
  const assertFolder = (id: string) => {
    assertCoworkFolder(coworkFolderGrants(context.store.root), {
      mode: "",
      conversation: context.store.conversation(id),
    });
    context.services?.workspaceTrust?.assert({
      mode: "",
      conversation: context.store.conversation(id),
    });
  };
  handle(
    "editPrompt",
    (
      id: unknown,
      turnId: unknown,
      text: unknown,
      providerId: unknown,
      model: unknown,
    ) => {
      assertFolder(string.parse(id));
      return context.engine.editPrompt(
        string.parse(id),
        string.parse(turnId),
        z.string().min(1).max(1000000).parse(text),
        string.parse(providerId),
        z.string().min(1).max(200).parse(model),
      );
    },
  );
  handle(
    "selectPromptVersion",
    (id: unknown, turnId: unknown, versionTurnId: unknown) =>
      context.engine.selectPromptVersion(
        string.parse(id),
        string.parse(turnId),
        string.parse(versionTurnId),
      ),
  );
  handle(
    "retryResponse",
    (id: unknown, turnId: unknown, providerId: unknown, model: unknown) => {
      assertFolder(string.parse(id));
      return context.engine.retryResponse(
        string.parse(id),
        string.parse(turnId),
        string.parse(providerId),
        z.string().min(1).max(200).parse(model),
      );
    },
  );
  handle("discardTurn", (id: unknown, turnId: unknown) =>
    context.engine.discardTurn(string.parse(id), string.parse(turnId)),
  );
  handle(
    "selectReplyVersion",
    (id: unknown, turnId: unknown, versionTurnId: unknown) =>
      context.engine.selectReplyVersion(
        string.parse(id),
        string.parse(turnId),
        string.parse(versionTurnId),
      ),
  );
  handle("interrupt", (id: any) => context.engine.interrupt(string.parse(id)));
  handle("approve", (id: any, result: any) =>
    context.engine.approve(z.union([z.string(), z.number()]).parse(id), result),
  );
  return { engineOf } as const;
}
