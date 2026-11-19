import { ordinaryAttachmentsUsedInIncognito, privateAttachmentDraft } from "../workspace/incognito-upload";
import { inlineAttachmentDisplaysSchema } from "../../shared/inline-attachment-display";
import { CodeUltracodeUnavailable } from "../../shared/code-session-settings";
import {completionQuotesSchema,parsePersistedCompletionQuotes} from "../../shared/completion-quotes";
import { skillReferencesSchema } from "../../shared/skill-references";
import { interruptExpectedTurn } from "../conversations/interrupt-target";
import type { CodeSessionEnvironmentSelection } from "../official-ui/native/code-session-environment";
import { officialCodeNewTaskInput, officialCodeSendStart, officialCodeSessionEnvironment, type CodeSendStart } from "../engine/code-send-start";
import { z } from "zod";
import type { Conversation } from "../../shared/types";
import { randomUUID } from "node:crypto";
import { registryOf } from "../engine/engine-registry";
import { isSetupHook } from "../../shared/session-setup";
import path from "node:path";
import { readOwnedTurnAttachment } from "./owned-turn-attachment";
import { storeAttachment } from "../engine/composer-files";
import { scheduledTaskSetupInput } from "../routines/scheduled-task-setup";
import {
  connectorOverridesInput,
  connectorToolOverridesInput,
} from "../../shared/project-tools-input";
import { knowledgeBasesInput, string, environmentInput } from "./conversations";
import { HIWONDER_KNOWLEDGE_SERVER, HIWONDER_KNOWLEDGE_TOOLS, HUANER_TECH, hiwonderKnowledgeEnabled } from "../../shared/knowledge-api";
import { sameEnvironment } from "../engine/engine-types";
import {
  coworkFolderGrants,
  assertCoworkFolder,
} from "../workspace/cowork-folders";
import { projectFolders } from "../../shared/project-folders";
import type { Context, Handle } from "./conversations";
import { folderBranchName } from "./official-git";
import { remoteCodeDirectory } from "../workspace/code-additional-folder";
import { officialCoworkSend } from "../engine/official-cowork-send";

/** What registerConversationTurnHandlers needs from conversations.ts. */
export interface RegisterConversationTurnHandlersKit {
  context: Context;
  handle: Handle;
}

/** Symbols cannot be supplied by a cloned renderer or Runner wire payload. */
export const dispatchDeliverySend = Symbol("Dispatch delivery");
export const remoteCodeSend = Symbol("Remote Code send");
export const officialCodeFollowupSend = Symbol("official Code follow-up");
export interface OfficialCodeFollowupSend {
  conversation: Conversation;
  eventId: string;
  inputHash?: string;
  sendText?: string;
  start?: CodeSendStart;
}

const officialChatMessageIdsInput = z.object({
  user: z.string().min(1).max(512),
  assistant: z.string().uuid(),
}).strict().refine(({ user, assistant }) => user.toLowerCase() !== assistant.toLowerCase());

export function registerConversationTurnHandlers(
  kit: RegisterConversationTurnHandlersKit,
) {
  const { context, handle } = kit;
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
  handle("send", async (raw: any, extra?: {
    setup?: unknown;
    folderBranch?: unknown;
    slashInput?: { text: string; uuid?: string };
    [dispatchDeliverySend]?: { id: string; current: () => boolean };
    [remoteCodeSend]?: { eventId: string; current: () => boolean; start: CodeSendStart };
    [officialCodeFollowupSend]?: OfficialCodeFollowupSend;
    [officialCodeSendStart]?: CodeSendStart;
    [officialCodeNewTaskInput]?: { uuid: string; createdAt: number };
    [officialCodeSessionEnvironment]?: CodeSessionEnvironmentSelection;
    [officialCoworkSend]?: true;
  }) => {
    const lease = versionLease();
    const dispatchDelivery = extra?.[dispatchDeliverySend];
    const dispatchDeliveryId = dispatchDelivery?.id;
    const remoteCode = extra?.[remoteCodeSend];
    const sendCurrent = () => lease.current() && (!dispatchDelivery || dispatchDelivery.current()) &&
      (!remoteCode || remoteCode.current());
    // A cloud session's setup (runner/src/dispatcher.ts). A window's
    // arguments are cloned data, so they never carry one.
    const candidate = extra?.setup;
    const setup = isSetupHook(candidate) ? candidate : undefined;
    const input = z
      .object({
        conversationId: z.string().optional(),
        continueCodeSession: z.boolean().optional(),
        newConversationId: z.string().uuid().optional(),
        codeRemoteControlAtStart: z.boolean().optional(),
        scheduledTaskSetup: scheduledTaskSetupInput.optional(),
        blankArtifactRevision: z
          .object({
            artifactId: z.string().uuid(),
            revision: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
        text: z.string().max(200000),
        officialChatMessageIds: officialChatMessageIdsInput.optional(),
        skillReferences: skillReferencesSchema.optional(),
        completionQuotes: completionQuotesSchema.optional(),
        inlineAttachmentDisplays: inlineAttachmentDisplaysSchema.optional(),
        sessionInstructions: z.string().max(200000).optional(),
        mode: z.enum(["chat", "cowork", "code"]),
        artifactOutputKind: z
          .enum(["docs", "slides", "design", "dashboard"])
          .optional(),
        codePermissionMode: z
          .enum(["auto", "manual", "acceptEdits", "plan", "bypass"])
          .optional(),
        codeUltracode: z.literal(true).optional(),
        taskPermission: z.enum(["default", "auto", "bypass"]).optional(),
        coworkPermissionMode: z.enum(["default", "auto", "bypass"]).optional(),
        webSearch: z.boolean().optional(),
        thinkingSummariesWanted: z.boolean().optional(),
        thinkingMode: z.enum(["standard", "extended"]).optional(),
        connectorOverrides: connectorOverridesInput.optional(),
        connectorToolOverrides: connectorToolOverridesInput.optional(),
        toolSearchMode: z.enum(["on", "off"]).optional(),
        research: z.boolean().optional(),
        knowledgeBases: knowledgeBasesInput.optional(),
        projectId: z.string().optional(),
        cwd: z.string().optional(),
        additionalFolders: z
          .array(z.string().min(1).max(4096))
          .max(20)
          .optional(),
        additionalWorktreeFolders: z.array(z.object({
          path: z.string().min(1).max(4096),
          sourceBranch: z.string().min(1).max(255).optional(),
        })).max(20).optional(),
        attachments: z.array(z.object({ id: z.string() })).max(12),
        providerId: string,
        model: z.string().max(200),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
          .optional(),
        incognito: z.boolean().optional(),
        memoryDisabled: z.literal(true).optional(),
        environment: environmentInput.optional(),
        asksFirst: z.boolean().optional(),
        worktree: z.boolean().optional(),
        worktreeBranch: z.string().min(1).max(255).optional(),
        worktreeBranchHint: z.string().max(512).optional(),
        autoPullRequest: z.enum(["ready", "draft"]).optional(),
        cloudEnvironmentId: z.string().max(100).optional(),
      })
      .parse(raw);
    if(input.completionQuotes!==undefined)input.completionQuotes=parsePersistedCompletionQuotes(input.text,input.completionQuotes);
    const existing = input.conversationId
      ? context.store.conversation(input.conversationId)
      : undefined;
    const nativeCowork = extra?.[officialCoworkSend] === true && input.mode === "cowork" &&
      (!existing || (existing.mode === "cowork" && !existing.cloudHosted &&
        (!existing.environment || existing.environment.kind === "local"))) &&
      (!input.environment || input.environment.kind === "local");
    if (input.codeUltracode && (
      input.conversationId || input.mode !== "code" || input.incognito ||
      input.environment?.kind === "ssh" || input.environment?.kind === "wsl" ||
      !lease.engine.codeUltracodeAvailable(input.providerId, input.model)
    ))
      throw new CodeUltracodeUnavailable();
    if (!existing) {
      const tools = input.connectorToolOverrides?.[HIWONDER_KNOWLEDGE_SERVER] ?? {};
      if (Object.keys(tools).some(tool => !HIWONDER_KNOWLEDGE_TOOLS.some(name => name === tool)))
        throw Error("This knowledge-base tool does not exist.");
      if (hiwonderKnowledgeEnabled(input) && HIWONDER_KNOWLEDGE_TOOLS.some(tool => tools[tool] !== false)) {
        const bases = await context.knowledgeCatalog?.();
        lease.check();
        if (!bases?.some(base => base.id === HUANER_TECH && base.available))
          throw Error("The knowledge base is unavailable. Try again when it reconnects.");
      }
    }
    const nativeStart = extra?.[officialCodeSendStart];
    const codeEnvironment = existing?.environment?.kind ?? input.environment?.kind ?? "local";
    const nativeNewTaskInput = nativeStart && existing && (codeEnvironment === "local" || codeEnvironment === "ssh") ? extra?.[officialCodeNewTaskInput] : undefined;
    const slashInput = nativeStart && (codeEnvironment === "local" || codeEnvironment === "ssh") ? extra?.slashInput : undefined;
    if (
      nativeStart &&
      (input.mode !== "code" ||
        (existing && existing.mode !== "code") ||
        (codeEnvironment !== "local" && codeEnvironment !== "wsl" && codeEnvironment !== "ssh"))
    )
      throw Error("This Code send is no longer local.");
    const sessionEnvironment = nativeStart && !input.conversationId ? extra?.[officialCodeSessionEnvironment] : undefined;
    const folderBranch = nativeStart && !existing && codeEnvironment === "local" && !input.worktree
      ? folderBranchName.optional().parse(extra?.folderBranch)
      : undefined;
    const codeFollowup = extra?.[officialCodeFollowupSend];
    const codeSendStart = nativeStart ?? codeFollowup?.start ?? remoteCode?.start;
    if (
      codeFollowup &&
      (!existing ||
        existing !== codeFollowup.conversation ||
        existing.mode !== "code" ||
        input.mode !== "code" ||
        existing.archived ||
        existing.incognito ||
        existing.cloudHosted ||
        existing.environment?.kind === "ssh" || existing.environment?.kind === "wsl")
    )
      throw Error("The Cloud Code session is no longer available.");
    if (
      input.continueCodeSession &&
      (!existing ||
        existing.mode !== "code" ||
        existing.cloudHosted ||
        (codeEnvironment !== "local" && codeEnvironment !== "wsl" && !(nativeStart && codeEnvironment === "ssh")))
    )
      throw Error(
        "Continuing a session requires an existing local Code conversation.",
      );
    if (input.sessionInstructions !== undefined && input.conversationId)
      throw Error(
        "Session instructions can only be supplied when creating a conversation.",
      );
    if (input.memoryDisabled && (existing || (input.mode !== "chat" && input.mode !== "cowork")))
      throw Error("Memory use is set when starting a Chat or Cowork session.");
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
    if (input.additionalWorktreeFolders?.length && (
      !nativeStart || existing ||
      input.additionalWorktreeFolders.some(({ path }) => !input.additionalFolders?.includes(path))
    ))
      throw Error("Choose worktrees from the additional folders of a new local Code session.");
    // A conversation keeps the environment it started in.
    const environment = existing ? existing.environment : input.environment;
    if (
      existing &&
      input.environment &&
      !sameEnvironment(existing.environment, input.environment)
    )
      throw new Error("This conversation runs somewhere else.");
    if (environment?.kind === "ssh" || environment?.kind === "wsl") {
      const label = environment.kind === "ssh" ? "SSH" : "WSL";
      if (input.mode !== "code" || (existing && existing.mode !== "code"))
        throw new Error(`${label} connections are only for Code.`);
      if (input.incognito)
        throw new Error(`${label} conversations can't be incognito.`);
      const registry = registryOf(lease.engine);
      if (!registry) throw new Error(`${label} connections aren't available.`);
      registry.allowedFolder(input.cwd ?? existing?.cwd, environment);
      let codeSessionFolderGrants: string[] | undefined;
      if (nativeStart && input.additionalFolders?.length) {
        const workspace = registry.worktreeWorkspace(environment);
        const folders = input.additionalFolders;
        const resolved = await Promise.all(folders.map(folder => workspace.resolveDirectory(remoteCodeDirectory.parse(folder))));
        lease.check();
        input.additionalFolders = resolved;
        input.additionalWorktreeFolders = input.additionalWorktreeFolders?.map(choice => ({
          ...choice, path: resolved[folders.indexOf(choice.path)],
        }));
        codeSessionFolderGrants = [...new Set(resolved)].filter(folder => {
          try { registry.allowedFolder(folder, environment); return false; }
          catch { return true; }
        });
      } else {
        for (const folder of input.additionalFolders ?? [])
          registry.allowedFolder(folder, environment);
      }
      const attachments = input.attachments.map((a) => {
        const known = context.selectedAttachments.get(a.id);
        if (!known)
          throw new Error(
            "This attachment is no longer available. Add it again.",
          );
        return known;
      });
      const conversation = await lease.engine.send(
        {
          ...input,
          ...sessionEnvironment,
          ...(codeSessionFolderGrants?.length ? { codeSessionFolderGrants } : {}),
          ...(existing ? {} : { environment }),
          ...(existing ? { cwd: existing.cwd } : {}),
          attachments,
          ...(dispatchDeliveryId ? { dispatchDeliveryId } : {}),
          ...(remoteCode ? { officialCodeEventId: remoteCode.eventId } : {}),
        },
        undefined,
        false,
        {
          current: sendCurrent,
          ...(codeSendStart ? { codeSendStart } : {}),
          ...(nativeNewTaskInput ? { nativeNewTaskInput } : {}),
          ...(input.continueCodeSession || dispatchDeliveryId ? { newTaskResolved: true } : {}),
        },
      );
      lease.check();
      return conversation;
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
      conversation: existing?.worktree ? { ...existing, cwd: existing.worktree.origin } : existing,
      cwd: workingFolder,
    });
    const attachments = input.attachments.map((a) => {
      let known = context.selectedAttachments.get(a.id);
      if (
        !known && existing && existing.mode === "chat" &&
        input.mode === "chat" && context.policy
      ) {
        lease.check();
        const historical = readOwnedTurnAttachment(context.store, existing.id, a.id);
        if (historical) {
          known = storeAttachment(
            path.join(context.store.root, "attachments"),
            historical.attachment.name,
            historical.data,
            context.policy(),
          );
          context.selectedAttachments.set(known.id, known);
        }
        lease.check();
      }
      if (!known)
        throw new Error(
          "This attachment is no longer available. Add it again.",
        );
      if (existing?.incognito ?? input.incognito) {
        if (!privateAttachmentDraft(context.store.root, known))
          ordinaryAttachmentsUsedInIncognito.add(known);
      } else if (privateAttachmentDraft(context.store.root, known)) {
        throw Error("This attachment belongs to a temporary chat.");
      }
      return known;
    });
    // A new task starts in the folder's real path, the one that was allowed.
    const conversation = await lease.engine.send(
      {
        ...input,
        ...sessionEnvironment,
        ...(folder ? { cwd: folder } : {}),
        attachments,
        ...(dispatchDeliveryId ? { dispatchDeliveryId } : {}),
        ...(setup && input.mode === "code" ? { setup } : {}),
        ...(slashInput ? {
          officialCodeDisplayText: slashInput.text,
          ...(slashInput.uuid ? { officialCodeEventId: slashInput.uuid } : {}),
        } : {}),
        ...(codeFollowup ? { officialCodeEventId: codeFollowup.eventId } : {}),
        ...(remoteCode ? { officialCodeEventId: remoteCode.eventId } : {}),
        ...(codeFollowup?.inputHash
          ? { officialCodeInputHash: codeFollowup.inputHash }
          : {}),
      },
      undefined,
      false,
      {
        current: () =>
          sendCurrent() &&
          (!codeFollowup || context.store.conversations.includes(codeFollowup.conversation)),
        ...(input.continueCodeSession || codeFollowup || dispatchDeliveryId ? { newTaskResolved: true } : {}),
        ...(codeSendStart ? { codeSendStart } : {}),
        ...(nativeNewTaskInput ? { nativeNewTaskInput } : {}),
        ...(nativeCowork ? { nativeCowork: true as const } : {}),
        ...(remoteCode ? { remoteCodeWorktree: true as const } : {}),
        ...(codeFollowup?.sendText === undefined ? {} : { codeSendText: codeFollowup.sendText }),
        ...(folderBranch ? {
          checkoutCodeBranch: (cwd: string, current: () => void) => {
            const branches = context.services?.folderBranchSwitch;
            if (!branches) throw Error("Local Git is unavailable.");
            return branches.checkout(cwd, folderBranch, current);
          },
        } : {}),
        ...(input.additionalWorktreeFolders?.length || existing?.worktree || existing?.remoteCodeWorktree || existing?.additionalWorktrees?.length ? {
          codeWorktreeFolderTrusted: (cwd: string) => {
            try {
              context.services?.workspaceTrust?.assert({ mode: "code", cwd });
              return true;
            } catch {
              return false;
            }
          },
        } : {}),
      },
    );
    lease.check();
    if (folder) grants.bind(conversation, folder);
    // A new Cowork task in a project gets the project's other folders (live
    // claude.ai bundle, 2026-10-12: a project binds up to 16 folders).
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
    lease.check();
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
  const versionOptionsInput = z
    .object({
      officialChatMessageIds: officialChatMessageIdsInput.optional(),
      completionQuotes: completionQuotesSchema.optional(),
        inlineAttachmentDisplays: inlineAttachmentDisplaysSchema.optional(),
      attachments: z
        .array(z.object({ id: z.string().min(1).max(200) }).strict())
        .max(12)
        .optional(),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
        .optional(),
    })
    .strict();
  const editOptionsInput = versionOptionsInput.extend({
    skillReferences: skillReferencesSchema.optional(),
  });
  const versionOptions = (
    raw: unknown,
    conversationId: string,
    turnId: string,
    editing = false,
  ) => {
    const parsed = editing
      ? editOptionsInput.optional().parse(raw)
      : versionOptionsInput.optional().parse(raw);
    if (!parsed) return undefined;
    const { attachments, ...rest } = parsed;
    if (attachments && new Set(attachments.map(file => file.id)).size !== attachments.length) throw Error("Duplicate attachment identity.");
    return {
      ...rest,
      ...(attachments === undefined
        ? {}
        : {
            attachments: attachments.map((item) => {
              const selected = context.selectedAttachments.get(item.id);
              const stored = context.store.conversation(conversationId).turns.find(turn => turn.id === turnId)?.attachments.filter(file => file.id === item.id) ?? [];
              if (stored.length > 1 || (selected && stored[0] && JSON.stringify(selected) !== JSON.stringify(stored[0]))) throw Error("The attachment identity is ambiguous.");
              const known = selected ?? stored[0];
              if (!known)
                throw Error(
                  "This attachment is no longer available. Add it again.",
                );
              return known;
            }),
          }),
    };
  };
  const versionLease = () => {
    const identity = context.accountActivationIdentity,
      store = context.store,
      engine = context.engine,
      account = context.activeAccount?.id;
    const check = () => {
      if (
        identity === undefined ||
        context.accountActivationIdentity !== identity ||
        context.accountRetiring !== false ||
        context.store !== store ||
        context.engine !== engine ||
        !account ||
        context.activeAccount?.id !== account
      )
        throw Error(
          "The account changed. The message operation may already have taken effect; reopen before retrying.",
        );
    };
    check();
    return {
      engine,
      check,
      current: () => {
        try {
          check();
          return true;
        } catch {
          return false;
        }
      },
    };
  };
  handle(
    "editPrompt",
    (
      id: unknown,
      turnId: unknown,
      text: unknown,
      providerId: unknown,
      model: unknown,
      rawOptions: unknown,
    ) => {
      assertFolder(string.parse(id));
      const lease = versionLease(),
        options = versionOptions(rawOptions, string.parse(id), string.parse(turnId), true);
      lease.check();
      return lease.engine
        .editPrompt(
          string.parse(id),
          string.parse(turnId),
          z.string().min(1).max(1000000).parse(text),
          string.parse(providerId),
          z.string().min(1).max(200).parse(model),
          { ...options, current: lease.current },
        )
        .then((result) => {
          lease.check();
          return result;
        });
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
    (
      id: unknown,
      turnId: unknown,
      providerId: unknown,
      model: unknown,
      rawOptions: unknown,
    ) => {
      assertFolder(string.parse(id));
      const lease = versionLease(),
        options = versionOptions(rawOptions, string.parse(id), string.parse(turnId));
      lease.check();
      return lease.engine
        .retryResponse(
          string.parse(id),
          string.parse(turnId),
          string.parse(providerId),
          z.string().min(1).max(200).parse(model),
          { ...options, current: lease.current },
        )
        .then((result) => {
          lease.check();
          return result;
        });
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
  handle("selectChatLeaf", async (id: unknown, rawTarget: unknown) => {
    const lease = versionLease();
    const target = z
      .object({
        conversationCreatedAt: z.number().int().nonnegative(),
        turnId: string,
        turnCreatedAt: z.number().int().nonnegative(),
        branchId: string.nullable(),
      })
      .strict()
      .parse(rawTarget);
    const result = await lease.engine.selectChatLeaf(
      string.parse(id),
      target,
      lease.current,
    );
    lease.check();
    return result;
  });
  handle("interrupt", (id: unknown, expected?: unknown) => {
    const parsed = string.parse(id);
    return expected === undefined
      ? context.engine.interrupt(parsed)
      : interruptExpectedTurn(context, parsed, expected);
  });
  handle("approve", (id: any, result: any) =>
    context.engine.approve(z.union([z.string(), z.number()]).parse(id), result),
  );
  return { engineOf } as const;
}
