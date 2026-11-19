import path from "node:path";
import { rm } from "node:fs/promises";
import { saveSessionConnectorPreference } from "./session-connector-preference";
import { beginCodeSessionLifecycle } from "../conversations/code-lifecycle-guard";
import { codeThinkingPreferenceSnapshot } from "../../shared/code-thinking-preferences";
import { supportsCodeUltracode } from "../../shared/code-session-settings";
import { assertCodeThinkingPreferenceAvailable, saveCodeThinkingPreference } from "./code-thinking-preferences";
import { acknowledgeCodeRead } from "./code-read-state";
import { readCodeModelPreference, saveCodeModelPreference } from "./code-model-preferences";
import { WebSearchSaveError } from "../store/store";
import { string, knowledgeBasesInput } from "./conversations";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import { discardIncognitoAttachments } from "../workspace/incognito-attachments";
import { discardIncognitoUploads, incognitoDraftId, privateAttachmentDraft } from "../workspace/incognito-upload";
import { realFolder } from "../workspace/workspace-trust";
import { codeScratchWorkspaceRoot } from "../workspace/code-scratch-workspace";
import { localCodeDirectory, remoteCodeDirectory, resolveLocalCodeDirectory } from "../workspace/code-additional-folder";
import { z } from "zod";
import {
  connectorOverridesInput,
  connectorToolOverridesInput,
} from "../../shared/project-tools-input";
import {
  codePermissionModeOf,
  codeSessionSettings,
} from "../../shared/code-session-permissions";
import { registryOf } from "../engine/engine-registry";
import { sameEnvironment } from "../engine/engine-types";
import { respondToTitleOffer } from "../../shared/title-offers";
import { onThisMachine } from "../../shared/types";
import { TaskBacklog } from "../conversations/task-backlog";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import { modelProtocol, routeForModel } from "../../shared/provider-routes";
import { researchConnectorEnabled } from "../../shared/research";
import { reorderSidebarConversations } from "../../shared/conversation-order";
import { isEditablePrivateChatProject } from "../../shared/project-access";
import {
  cleanupRemoteCodeWorktree,
  conversationWorktrees,
  removeSessionWorktree,
  deleteMergedBranch,
  probeSessionWorktree,
  restoreSessionWorktree,
  restoreSessionFolderWorktree,
} from "../git/code-worktree";
import {
  probeRemoteSessionWorktree,
  removeRemoteSessionWorktree,
  restoreRemoteSessionFolderWorktree,
  restoreRemoteSessionWorktree,
} from "../git/remote-code-worktree";
import type { Conversation } from "../../shared/types";
import type { Context, Handle } from "./conversations";
import type { Engine } from "../engine/engine";
import { HIWONDER_KNOWLEDGE_SERVER } from "../../shared/knowledge-api";

type CodeWorktree = NonNullable<Conversation["worktree"]>;

/** What registerConversationManageHandlers needs from conversations.ts. */
export interface RegisterConversationManageHandlersKit {
  context: Context;
  engineOf: (conversationId: string) => Engine | undefined;
  handle: Handle;
}

export function registerConversationManageHandlers(
  kit: RegisterConversationManageHandlersKit,
) {
  const { context, engineOf, handle } = kit;
  const codeWorktreeRequest = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("probe"), sessionId: string }),
    z.object({ kind: z.literal("probeByFolder"), sessionId: string }),
    z.object({
      kind: z.literal("archive"),
      sessionId: string,
      paths: z.array(z.string()).max(21),
      cleanupWorktree: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("delete"), sessionId: string, paths: z.array(z.string()).min(1).max(21) }),
    z.object({ kind: z.literal("discardKept"), sessionId: string }),
  ]);
  const deletingConversations = new WeakSet<Conversation>();
  const desktopCode = (c: Conversation) => c.mode === "code" &&
    !c.cloudHosted && !c.cloudEnvironmentId &&
    c.environment?.kind !== "space";
  const worktreeWorkspace = (c: Conversation) =>
    c.environment?.kind === "ssh" || c.environment?.kind === "wsl"
      ? registryOf(context.engine)?.worktreeWorkspace(c.environment)
      : undefined;
  const connectWorktreeHost = (c: Conversation, interactive = true) => c.environment?.kind === "ssh"
    ? registryOf(context.engine)?.connectWorktreeHost(c.environment, interactive)
    : undefined;
  const availableCodeHost = (c: Conversation) => {
    if (c.environment?.kind !== "ssh") return true;
    const ssh = context.services?.ssh;
    return ssh?.allowed() === true && Boolean(ssh.hosts.get(c.environment.hostId));
  };
  const codeSessionCurrent = (c: Conversation) => {
    const store = context.store, generation = context.accountGeneration?.();
    const account = context.activeAccount?.id, id = c.id, createdAt = c.createdAt;
    return () => !context.accountRetiring && context.store === store &&
      context.accountGeneration?.() === generation && context.activeAccount?.id === account &&
      c.id === id && c.createdAt === createdAt && desktopCode(c) && availableCodeHost(c) &&
      (!c.sessionAuthors || (!!account && c.sessionAuthors.ownerAccountUuid === account)) &&
      store.conversations.includes(c) && store.conversations.filter(row => row.id === id).length === 1;
  };
  const lifecycleCurrent = (c: Conversation) => {
    context.store.assertLocalCodeLifecycleAvailable();
    if (context.accountGeneration?.() == null)
      throw Error("Account-scoped Code session changes are unavailable.");
    const current = codeSessionCurrent(c);
    return () => current() && !c.turns.some(turn => turn.status === "inProgress");
  };
  const listedDirty = new WeakMap<CodeWorktree, () => boolean>();
  const includesFolder = (root: string, folder?: string) => {
    if (!folder) return false;
    const relative = path.relative(root, realFolder(folder));
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  const worktreeInUse = (c: Conversation, worktree: CodeWorktree) => {
    const local = onThisMachine(c.environment);
    const inside = local ? includesFolder : (root: string, folder?: string) => {
      if (!folder) return false;
      const relative = path.posix.relative(root, folder);
      return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
    };
    const root = local ? realFolder(worktree.path) : worktree.path;
    return context.store.conversations.some(other => other !== c && !other.archived &&
      sameEnvironment(other.environment, c.environment) &&
      [other.cwd, other.worktree?.path, ...(other.additionalFolders ?? [])].some(folder => inside(root, folder)));
  };
  const updateConversation = (
    id: unknown,
    raw: any,
    { discardWorktrees = new Set<CodeWorktree>(), cleanupWorktree = true, autoArchive, modelPreferenceCurrent }: {
      discardWorktrees?: Set<CodeWorktree>;
      cleanupWorktree?: boolean;
      autoArchive?: (ownsLifecycle?: boolean) => boolean;
      modelPreferenceCurrent?: () => boolean;
    } = {},
  ) => {
    if (raw && typeof raw === "object" &&
        (Object.hasOwn(raw, "connectorOverrides") || Object.hasOwn(raw, "connectorToolOverrides")))
      return saveSessionConnectorPreference(context, string.parse(id), raw);
    if (raw && typeof raw === "object" && raw.thinkingSummariesWanted !== null &&
        typeof raw.thinkingSummariesWanted === "object")
      return saveCodeThinkingPreference(context, context.store.conversation(string.parse(id)), raw);
    if (raw && typeof raw === "object" && raw.unread !== null && typeof raw.unread === "object")
      return acknowledgeCodeRead(context, context.store.conversation(string.parse(id)), raw);
    // The guarded route uses a versioned object in the existing projectId field.
    // Older handlers reject that field's type before effects, rather than silently
    // ignoring a newer optional argument or stripping an unknown guard key.
    const envelope = raw && typeof raw === "object" && raw.projectId !== null &&
      typeof raw.projectId === "object"
      ? z.object({ projectId: z.object({
          version: z.literal(1),
          target: string.nullable(),
          expected: z.object({
            conversationId: string,
            mode: z.enum(["chat", "cowork"]),
            createdAt: z.number().finite().nullable(),
            sourceProjectId: string.nullable(),
            destinationCreatedAt: z.number().finite().nullable(),
          }).strict(),
        }).strict() }).strict().parse(raw).projectId
      : undefined;
    const c = context.store.conversation(string.parse(id));
    context.store.assertConversationMetadataWritable(c.id);
    if (envelope) {
      const { target, expected } = envelope;
      const store = context.store, generation = context.accountGeneration?.();
      const account = context.activeAccount?.id, activation = context.accountActivationIdentity;
      if (!context.accountGeneration || generation == null)
        throw Error("Account-scoped conversation updates are unavailable on this host.");
      store.assertConversationProjectWritable(c.id);
      const source = expected.sourceProjectId;
      const sourceOrganization = c.projectOrganizationId;
      const sourceProject = store.projects.find(project => project.id === source);
      const destination = store.projects.find(project => project.id === target);
      const destinationCwd = destination?.cwd, destinationEnvironment = structuredClone(destination?.environment);
      const cwd = c.cwd, environment = structuredClone(c.environment), incognito = c.incognito;
      const projectCurrent = () => {
        if (!sourceOrganization && source !== null && (store.isProjectDeleting(source) ||
            store.projects.find(project => project.id === source) !== sourceProject)) return false;
        if (target === null) return expected.destinationCreatedAt === null;
        return !!destination && !store.isProjectDeleting(target) &&
          destination.id === target && (destination.createdAt ?? null) === expected.destinationCreatedAt &&
          isEditablePrivateChatProject(destination) && store.projects.includes(destination) &&
          store.projects.filter(project => project.id === target).length === 1 &&
          (expected.mode === "cowork" ||
            destination.cwd === destinationCwd && sameEnvironment(destination.environment, destinationEnvironment));
      };
      const identityCurrent = () => !context.accountRetiring && context.store === store &&
        context.accountGeneration?.() === generation && context.activeAccount?.id === account &&
        context.accountActivationIdentity === activation && c.id === expected.conversationId &&
        c.mode === expected.mode && (c.createdAt ?? null) === expected.createdAt &&
        c.incognito === incognito && sameEnvironment(c.environment, environment) &&
        !deletingConversations.has(c) &&
        store.conversations.includes(c) && store.conversations.filter(row => row.id === c.id).length === 1 &&
        projectCurrent();
      const current = () => identityCurrent() && (c.projectId ?? null) === source &&
        c.projectOrganizationId === sourceOrganization && c.cwd === cwd;
      if (!current())
        throw Error("The conversation or project changed before the project move. Refresh its status before retrying.");
      let nextCwd = cwd;
      if (expected.mode === "chat" && !incognito && destinationCwd &&
          sameEnvironment(destinationEnvironment, environment)) {
        if (environment?.kind === "ssh") registryOf(context.engine)?.allowedFolder(destinationCwd, environment);
        else context.allowedFolder(destinationCwd);
        nextCwd = destinationCwd;
      }
      const membership = { projectId: target ?? undefined, projectOrganizationId: undefined, cwd: nextCwd };
      return (async () => {
        const unconfirmed = () => Error("The project move could not be confirmed. Reopen the account to check its status before retrying.");
        try { await store.persistConversationProjectMove(c, membership, current); }
        catch { throw unconfirmed(); }
        if (!identityCurrent() || (c.projectId ?? null) !== target || c.projectOrganizationId || c.cwd !== nextCwd)
          throw unconfirmed();
        context.push?.({ type: "conversation", conversation: structuredClone(c) });
        return structuredClone(c);
      })();
    }
    const codeModelPreference = raw && typeof raw.model === "object" && raw.model !== null
      ? readCodeModelPreference(raw, c) : undefined;
    if (codeModelPreference) raw = codeModelPreference;
    const patch = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        titleSource: z.enum(["auto", "user"]).optional(),
        thinkingSummariesWanted: z.boolean().optional(),
        thinkingMode: z.enum(["standard", "extended"]).optional(),
        sessionAuthors: z
          .object({
            viewerAccountUuid: z.string().min(1).max(200),
            ownerAccountUuid: z.string().min(1).max(200),
          })
          .nullable()
          .optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        projectId: z.string().nullable().optional(),
        unread: z.boolean().optional(),
        knowledgeBases: knowledgeBasesInput.optional(),
        connectorOverrides: connectorOverridesInput.optional(),
        connectorToolOverrides: connectorToolOverridesInput.optional(),
        toolSearchMode: z.enum(["on", "off"]).optional(),
        remoteControl: z.boolean().optional(),
        codePermissionMode: z
          .enum(["auto", "manual", "acceptEdits", "plan", "bypass"])
          .optional(),
        chatPermissionMode: z.enum(["default", "auto"]).optional(),
        keepAwake: z.boolean().optional(),
        prMerged: z.boolean().optional(),
        prAutoFix: z
          .object({ ci: z.boolean(), comments: z.boolean() })
          .optional(),
        prAutoArchive: z.boolean().optional(),
        providerId: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
        goal: z
          .object({
            condition: z.string().trim().min(1).max(2000),
            setAt: z.number().finite(),
            iterations: z.number().int().min(0),
            lastReason: z.string().max(1000).optional(),
          })
          .nullable()
          .optional(),
        outputStyle: z.string().trim().min(1).max(100).optional(),
        customOutputStyles: z
          .record(
            z.string(),
            z.object({
              name: z.string().min(1).max(100),
              prompt: z.string().min(1).max(10000),
            }),
          )
          .optional(),
        cwd: z.string().min(1).max(4096).optional(),
        additionalFolders: z
          .array(z.string().min(1).max(4096))
          .max(20)
          .optional(),
        parentSessionId: z.string().min(1).max(200).nullable().optional(),
        nestedSessionsHidden: z.boolean().optional(),
        titleOffersSuppressed: z.boolean().optional(),
        titleOffer: z
          .object({
            proposedTitle: z.string().trim().min(1).max(200),
            at: z.number().finite(),
          })
          .nullable()
          .optional(),
        titleOfferResponse: z
          .object({
            at: z.number().finite(),
            action: z.enum(["accept", "keep", "suppress"]),
          })
          .optional(),
        completedAt: z.number().finite().nullable().optional(),
        runnerReleasedAt: z.number().finite().nullable().optional(),
      })
      .refine(
        (value) =>
          (value.providerId === undefined) === (value.model === undefined),
        {
          message: "Choose a model service and a model together.",
        },
      )
      .parse(raw);
    if (patch.chatPermissionMode !== undefined) {
      if (c.mode !== "chat" || Object.keys(patch).length !== 1)
        throw Error("Update Chat permission separately.");
      if (!context.policy?.().permissionModes.includes(patch.chatPermissionMode === "auto" ? "auto" : "manual"))
        throw Error("This permission mode is not allowed.");
    }
    if (patch.thinkingSummariesWanted !== undefined) {
      assertCodeThinkingPreferenceAvailable(c);
      // Keep legacy booleans supported, with the same durable local Code save.
      // Other modes/environments retain their established update behavior.
      if (c.mode === "code" && !c.cloudHosted && !c.cloudEnvironmentId &&
          (!c.environment || c.environment.kind === "local")) {
        if (Object.keys(patch).length !== 1)
          throw Error("Update thinking summaries separately.");
        return saveCodeThinkingPreference(context, c, { thinkingSummariesWanted: {
          version: 1, wanted: patch.thinkingSummariesWanted,
          expected: codeThinkingPreferenceSnapshot(c),
        } });
      }
    }
    if (codeModelPreference)
      return saveCodeModelPreference(context, c, codeModelPreference, modelPreferenceCurrent);
    if (patch.titleSource !== undefined &&
        (c.mode !== "code" || patch.title === undefined ||
         Object.keys(patch).some(key => !["title", "titleSource", "pinned"].includes(key))))
      throw new Error("Code title updates must include a title and use a separate metadata update.");
    const projectMove = (c.mode === "chat" || c.mode === "cowork") &&
      Object.keys(patch).length === 1 && patch.projectId !== undefined;
    if (patch.projectId !== undefined) context.store.assertConversationProjectWritable(c.id);
    if (patch.projectId !== undefined && (
      (c.projectId && context.store.isProjectDeleting(c.projectId)) ||
      (patch.projectId && context.store.isProjectDeleting(patch.projectId))
    )) throw Error("This project is being deleted.");
    const projectStore = projectMove ? context.store : undefined;
    const projectGeneration = projectMove ? context.accountGeneration?.() : undefined;
    const projectConversationId = c.id;
    const projectDestination = projectMove && patch.projectId !== null
      ? projectStore!.projects.find(project => project.id === patch.projectId) : undefined;
    if (projectMove && patch.projectId !== null && !projectDestination)
      throw Error("Unknown project.");
    const projectDestinationCreatedAt = projectDestination?.createdAt;
    const projectCurrent = () => context.store === projectStore &&
      context.accountGeneration?.() === projectGeneration && c.id === projectConversationId &&
      !!projectStore?.conversations.includes(c) &&
      projectStore.conversations.filter(item => item.id === projectConversationId).length === 1 &&
      (patch.projectId === null || (!!projectDestination &&
        projectDestination.id === patch.projectId &&
        projectDestination.createdAt === projectDestinationCreatedAt &&
        (projectDestination.kind ?? "chat") === "chat" &&
        projectStore.projects.includes(projectDestination) &&
        projectStore.projects.filter(project => project.id === patch.projectId).length === 1));
    if (projectMove) {
      if (!context.accountGeneration || projectGeneration == null)
        throw new Error("Account-scoped conversation updates are unavailable on this host.");
      assertAccountOperationCurrent(projectCurrent);
    }
    if (desktopCode(c) && patch.archived !== undefined) {
      if (Object.keys(patch).some(key => key !== "archived" && key !== "prMerged") ||
          (patch.prMerged !== undefined && patch.archived !== true))
        throw Error("Archive Code sessions separately from other updates.");
      const store = context.store, current = lifecycleCurrent(c);
      assertAccountOperationCurrent(current);
      if (autoArchive && !autoArchive()) return structuredClone(c);
      const release = beginCodeSessionLifecycle(c);
      return (async () => {
        try {
          if (patch.archived && !c.archived) await context.closeTerminals?.(c.id);
          assertAccountOperationCurrent(current);
          if (autoArchive && !autoArchive(true)) return structuredClone(c);
          // Failed restoration must remain archived so the original menu still offers Restore.
          const worktrees = conversationWorktrees(c);
          const remote = worktrees.length ? worktreeWorkspace(c) : undefined;
          if (worktrees.length && !remote && !onThisMachine(c.environment))
            throw Error("The Code worktree host is unavailable.");
          if (!patch.archived) {
            if (remote) await connectWorktreeHost(c);
            assertAccountOperationCurrent(current);
            for (const worktree of worktrees) {
              const extra = c.additionalWorktrees?.find(tree => tree === worktree);
              const treeCurrent = () => current() && conversationWorktrees(c).includes(worktree);
              let branch: string | undefined;
              if (remote) {
                branch = extra
                  ? await restoreRemoteSessionFolderWorktree(remote, extra)
                  : await restoreRemoteSessionWorktree(remote, worktree, c.cwd);
              } else if (extra) await restoreSessionFolderWorktree(extra);
              else await restoreSessionWorktree(worktree, undefined, c.cwd);
              assertAccountOperationCurrent(treeCurrent);
              if (branch) {
                const changes = extra
                  ? { additionalWorktrees: c.additionalWorktrees?.map(tree => tree === extra ? { ...tree, branch } : tree) }
                  : { worktree: { ...worktree, branch } };
                store.commitLocalCodeHistory(c, changes, undefined, treeCurrent);
              }
            }
          }
          store.commitLocalCodeLifecycle(c, patch.archived!, current);
          // Cleanup starts only after a durable archive, while sends remain blocked.
          if (patch.archived) {
            if (remote && cleanupWorktree)
              await connectWorktreeHost(c, patch.prMerged !== true)?.catch(() => undefined);
            assertAccountOperationCurrent(current);
            for (const worktree of worktrees) {
              listedDirty.delete(worktree);
              if (!cleanupWorktree) continue;
              await settleWorktree(c, worktree, true, !remote && patch.prMerged === true && worktree === c.worktree,
                discardWorktrees.has(worktree));
            }
          }
          assertAccountOperationCurrent(current);
          if (c.archived !== patch.archived || (!patch.archived && conversationWorktrees(c).some(tree => tree.state === "deleted")))
            throw Error("The Code session restore could not be confirmed. Reopen before retrying.");
          context.push?.({
            type: "conversation", conversation: structuredClone(c),
            ...(autoArchive ? { codeAutoArchived: true } : {}),
          });
          return structuredClone(c);
        } finally { release(); }
      })();
    }
    const chatArchive = c.mode === "chat" && Object.keys(patch).length === 1 && patch.archived !== undefined;
    const archiveStore = chatArchive ? context.store : undefined;
    const archiveGeneration = chatArchive ? context.accountGeneration?.() : undefined;
    const archiveCurrent = () => context.store === archiveStore &&
      context.accountGeneration?.() === archiveGeneration && !!archiveStore?.conversations.includes(c);
    if (chatArchive) {
      if (!context.accountGeneration || archiveGeneration == null)
        throw new Error("Account-scoped conversation updates are unavailable on this host.");
      assertAccountOperationCurrent(archiveCurrent);
    }
    // Plain Chat/Code rename/pin must acknowledge persistence before reporting success.
    // Archive remains on its existing side-effect path; it is not a transaction.
    if ((c.mode === "chat" || c.mode === "code") && Object.keys(patch).length > 0 &&
        Object.keys(patch).every(key => key === "title" || key === "titleSource" || key === "pinned")) {
      const store = context.store, generation = context.accountGeneration?.();
      if (!context.accountGeneration || generation == null)
        throw new Error("Account-scoped conversation updates are unavailable on this host.");
      const current = () => context.store === store &&
        context.accountGeneration?.() === generation && store.conversations.includes(c);
      assertAccountOperationCurrent(current);
      const { titleSource, ...metadata } = patch;
      // An automatic result can arrive after the person has renamed the session.
      // Source metadata, not a guess about the provisional title text, owns this guard.
      if (titleSource === "auto" && c.titleSetByUser) delete metadata.title;
      const next = { ...metadata, ...(metadata.title !== undefined &&
        (c.mode === "code" || metadata.title !== c.title) ? {
        titleSetByUser: c.mode !== "code" || titleSource !== "auto",
      } : {}) };
      return store.persistChatMetadata(c, next, current).then(() => {
        assertAccountOperationCurrent(current);
        if (Object.entries(next).some(([key, value]) => (c as any)[key] !== value))
          throw new Error("A newer conversation update replaced this save; its outcome is unknown.");
        context.push?.({ type: "conversation", conversation: structuredClone(c) });
        return structuredClone(c);
      });
    }
    if (c.mode === "chat" && patch.unread !== undefined && Object.keys(patch).length === 1) {
      const store = context.store, generation = context.accountGeneration?.();
      const current = () => !context.accountRetiring && context.store === store &&
        context.accountGeneration?.() === generation && store.conversations.includes(c);
      const next = {
        unread: patch.unread,
        readStateRevision: Math.max(Date.now(), (c.readStateRevision ?? 0) + 1),
      };
      return store.persistChatMetadata(c, next, current).then(() => {
        assertAccountOperationCurrent(current);
        if (c.readStateRevision !== next.readStateRevision)
          throw Error("A newer conversation update replaced this save.");
        if (!next.unread) context.scheduler?.markConversationRead(c.id);
        context.push?.({ type: "conversation", conversation: structuredClone(c) });
        return structuredClone(c);
      });
    }
    if (patch.codePermissionMode !== undefined) {
      if (c.mode !== "code")
        throw Error("Only Code sessions have a Code permission choice.");
      if (c.scheduledRun && c.scheduledPermission !== undefined)
        throw Error("Permissions follow this scheduled task.");
      if (Object.keys(patch).length !== 1)
        throw Error("Update session permissions separately.");
      const previous = c.codePermissionMode;
      const previousRevision = c.codePermissionRevision;
      const turn = c.turns.at(-1);
      const previousTurn = turn?.codePermissionMode;
      if (
        turn?.status === "inProgress" &&
        turn.codePermissionMode === undefined
      )
        turn.codePermissionMode = codePermissionModeOf(
          codeSessionSettings(context.store.settings, c.codePermissionMode),
        );
      c.codePermissionMode = patch.codePermissionMode;
      c.codePermissionRevision =
        (Number.isSafeInteger(previousRevision) && previousRevision! >= 0
          ? previousRevision!
          : 0) + 1;
      try {
        context.store.write(
          "conversations.json",
          context.store.conversations.filter((item) => !item.incognito),
        );
      } catch (error) {
        if (previous === undefined) delete c.codePermissionMode;
        else c.codePermissionMode = previous;
        if (previousRevision === undefined) delete c.codePermissionRevision;
        else c.codePermissionRevision = previousRevision;
        if (turn) {
          if (previousTurn === undefined) delete turn.codePermissionMode;
          else turn.codePermissionMode = previousTurn;
        }
        throw error;
      }
      context.push?.({
        type: "conversation",
        conversation: structuredClone(c),
      });
      return structuredClone(c);
    }
    // A session nests under another existing one, never under itself or one
    // of its own nested sessions.
    if (patch.parentSessionId) {
      const conversations = context.store.conversations;
      for (
        let parent = conversations.find((v) => v.id === patch.parentSessionId),
          steps = 0;
        parent;
        parent = conversations.find((v) => v.id === parent!.parentSessionId),
          steps++
      )
        if (parent.id === c.id || steps > 100)
          throw Error("A session can't be nested under itself.");
      if (!conversations.some((v) => v.id === patch.parentSessionId))
        throw Error("That session no longer exists.");
    }
    if (patch.cwd !== undefined || patch.additionalFolders !== undefined) {
      if (c.mode !== "code") throw Error("Only Code sessions can add folders.");
      if (patch.cwd !== undefined && c.cwd)
        throw Error("This session already has a working folder.");
      const allowed = (folder: string) => {
        if (c.environment?.kind === "ssh")
          registryOf(context.engine)!.allowedFolder(folder, c.environment);
        else context.allowedFolder(folder);
      };
      if (patch.cwd !== undefined) allowed(patch.cwd);
      if (patch.additionalFolders !== undefined) {
        patch.additionalFolders = [...new Set(patch.additionalFolders)].filter(
          (folder) => folder !== (patch.cwd ?? c.cwd),
        );
        for (const folder of patch.additionalFolders) allowed(folder);
      }
    }
    if (patch.model !== undefined && c.mode === "chat") {
      const model = patch.model;
      if (Object.keys(patch).some(key => key !== "model" && key !== "providerId" && key !== "effort") ||
          patch.providerId !== c.providerId || c.archived || c.linkedToComputer ||
          c.chatDeviceBinding || c.deviceChatOrigin?.active)
        throw Error("This conversation cannot change model.");
      const store = context.store, generation = context.accountGeneration?.();
      const account = context.activeAccount?.id;
      const current = () => !context.accountRetiring && context.store === store &&
        context.accountGeneration?.() === generation && context.activeAccount?.id === account &&
        store.conversations.includes(c) && !c.archived &&
        (!c.sessionAuthors || c.sessionAuthors.ownerAccountUuid === account && c.sessionAuthors.viewerAccountUuid === account);
      assertAccountOperationCurrent(current);
      const provider = store.settings.providers.find(item => item.id === c.providerId);
      if (!provider || !(provider.model === model || provider.models.includes(model) || routeForModel(provider, model)))
        throw Error("This account cannot use the selected model.");
      const measured = c.tokenUsage;
      const next = { model, effort: patch.effort,
        ...(model !== c.model && measured && measured.model === undefined
          ? { tokenUsage: { ...measured, model: c.model } } : {}) };
      return store.persistChatMetadata(c, next, current).then(() => {
        assertAccountOperationCurrent(current);
        if (c.model !== model || c.effort !== next.effort)
          throw Error("The Chat model change could not be confirmed. Reopen the conversation before retrying.");
        context.push?.({ type: "conversation", conversation: structuredClone(c) });
        return structuredClone(c);
      });
    }
    if (patch.model !== undefined) {
      if ((c.mode !== "code" && c.mode !== "cowork") || c.incognito)
        throw Error("This session cannot change model.");
      if (c.mode === "cowork" && (c.archived || c.cloudHosted || c.chatDeviceBinding || c.deviceChatOrigin?.active || patch.providerId !== c.providerId))
        throw Error("This Cowork session cannot change model here.");
      const provider = context.store.settings.providers.find(
        (item) => item.id === patch.providerId,
      );
      if (!provider) throw Error("This model service isn't available.");
      if (
        provider.models.length &&
        !new Set([provider.model, ...provider.models]).has(patch.model)
      )
        throw Error("This account cannot use the selected model.");
    }
    if (patch.projectId) {
      const project = context.store.projects.find(
        (value) => value.id === patch.projectId,
      );
      if (!project) throw Error("Unknown project.");
      // A project's folder applies only in its own environment (R9): an
      // SSH conversation keeps its folder on the host.
      if (
        !(c.incognito && c.mode !== "code") &&
        project.cwd &&
        sameEnvironment(project.environment, c.environment)
      ) {
        if (c.environment?.kind === "ssh")
          registryOf(context.engine)?.allowedFolder(project.cwd, c.environment);
        else context.allowedFolder(project.cwd);
        c.cwd = project.cwd;
      }
    }
    if (patch.archived) void context.closeTerminals?.(c.id);
    const {
      remoteControl,
      keepAwake,
      prMerged,
      prAutoFix,
      prAutoArchive,
      titleOfferResponse,
      sessionAuthors,
      ...rest
    } = patch;
    if (patch.title !== undefined && patch.title !== c.title)
      c.titleSetByUser = true;
    if (titleOfferResponse) respondToTitleOffer(c, titleOfferResponse);
    if (patch.titleOffersSuppressed && c.titleOffer)
      c.titleOffer.state = "suppressed";
    if (sessionAuthors === null) delete c.sessionAuthors;
    else if (sessionAuthors !== undefined) c.sessionAuthors = sessionAuthors;
    // The session's auto-archive switch, kept with the session so Claude's
    // set_pr_monitor and the person's switch agree.
    if (prAutoArchive !== undefined && c.mode === "code") {
      c.prAutoArchive = prAutoArchive;
      if (prAutoArchive) delete c.codeAutoArchiveExempt;
    }
    // The CI popover's switches; what was already reported is kept.
    if (prAutoFix) {
      if (c.mode !== "code" || c.incognito)
        throw Error("Only a Code session's pull request has Auto-fix.");
      c.prAutoFix = {
        ci: prAutoFix.ci,
        comments: prAutoFix.ci && prAutoFix.comments,
        ...(c.prAutoFix?.delivered ? { delivered: c.prAutoFix.delivered } : {}),
      };
    }
    if (keepAwake !== undefined) {
      if (c.mode !== "code" || c.incognito)
        throw Error("Only a Code session keeps this computer awake.");
      if (keepAwake && !c.archived && !patch.archived) c.keepAwake = true;
      else delete c.keepAwake;
    }
    // An archived session stops holding the computer awake (the original
    // clears manualKeepAwake on archive).
    if (patch.archived) delete c.keepAwake;
    if (remoteControl !== undefined) {
      if (c.mode !== "code" || c.incognito)
        throw Error("Only a Code session connects to Remote Control.");
      if (remoteControl) delete c.remoteControlOff;
      else c.remoteControlOff = true;
    }
    if (c.mode === "code" && patch.unread !== undefined) {
      const revision = c.readStateRevision ?? 0;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
        throw Error("The Code read state is invalid. Reopen the account before retrying.");
      c.readStateRevision = revision + 1;
    }
    if (c.mode === "code" && c.codeUltracode && patch.model !== undefined && patch.providerId !== undefined &&
      (patch.model !== c.model || patch.providerId !== c.providerId) &&
      !supportsCodeUltracode(context.engine.modelEfforts(patch.providerId, patch.model)))
      c.codeUltracode = false;
    Object.assign(c, rest);
    if (patch.projectId !== undefined) delete c.projectOrganizationId;
    // A session's own worktree goes with archiving when it has no changes
    // (kept otherwise), and comes back from its branch on unarchiving.
    if (c.worktree && patch.archived !== undefined)
      void settleWorktree(c, c.worktree, patch.archived, prMerged === true);
    if (patch.projectId === null) c.projectId = undefined;
    if (patch.unread === false) {
      delete c.unread;
      context.scheduler?.markConversationRead(c.id);
    }
    // Knowledge bases (shared/knowledge-api.ts): none means off; the agent's
    // servers follow at the next send (the knowledge extension).
    if (patch.knowledgeBases !== undefined) {
      if (!patch.knowledgeBases.length) delete c.knowledgeBases;
      if (c.connectorOverrides && Object.hasOwn(c.connectorOverrides, HIWONDER_KNOWLEDGE_SERVER))
        delete c.connectorOverrides[HIWONDER_KNOWLEDGE_SERVER];
      if (c.connectorToolOverrides && Object.hasOwn(c.connectorToolOverrides, HIWONDER_KNOWLEDGE_SERVER)) {
        const overrides = { ...c.connectorToolOverrides };
        delete overrides[HIWONDER_KNOWLEDGE_SERVER];
        c.connectorToolOverrides = overrides;
      }
    }
    // Preserve archive's original effects and order. A failed confirmation is
    // not a rollback: terminal/worktree/keep-awake changes may already exist.
    if (chatArchive) {
      const unknown = () => new Error("The archive update could not be confirmed. Some session changes may already have occurred; reopen before retrying.");
      try { assertAccountOperationCurrent(archiveCurrent); archiveStore!.flush(); } catch { throw unknown(); }
      return archiveStore!.confirmConversationMetadata(c, archiveCurrent, true).then(() => {
        assertAccountOperationCurrent(archiveCurrent);
        if (c.archived !== patch.archived) throw unknown();
        context.push?.({ type: "conversation", conversation: structuredClone(c) });
        return structuredClone(c);
      }, () => { throw unknown(); });
    }
    // Membership uses the existing metadata acknowledgement, after the original
    // project/folder effects and one flush. It is not an all-or-nothing move.
    if (projectMove) {
      const unknown = () => new Error("The project move could not be confirmed. Some changes may already have occurred; refresh its status before retrying.");
      return (async () => {
        try {
          assertAccountOperationCurrent(projectCurrent);
          // Preserve the captured identity through flush's existing legacy
          // visibility migration. Missing visibility already means private;
          // explicit visibility is never relabeled or granted new access.
          if (projectDestination && !Object.hasOwn(projectDestination, "visibility"))
            projectDestination.visibility = "private";
          projectStore!.flush();
          await projectStore!.confirmConversationMetadata(c, projectCurrent, true);
          assertAccountOperationCurrent(projectCurrent);
          if ((c.projectId ?? null) !== patch.projectId) throw unknown();
          context.push?.({ type: "conversation", conversation: structuredClone(c) });
          return structuredClone(c);
        } catch { throw unknown(); }
      })();
    }
    context.store.flush();
    // The account's other windows and devices follow (owner, 2026-10-03: a
    // chat read on the web stayed marked unread on the desktop).
    context.push?.({ type: "conversation", conversation: structuredClone(c) });
    return c;
  };
  handle("autoArchiveLocalCode", (id, merged: boolean, eligible: (ownsLifecycle?: boolean) => boolean) => {
    if (typeof eligible !== "function") throw Error("Code auto-archive requires the desktop scheduler.");
    return updateConversation(id, { archived: true, prMerged: merged }, { autoArchive: eligible });
  });
  handle("updateConversation", (id, raw, nativeDirectoryLease?: () => boolean) => {
    if (typeof nativeDirectoryLease !== "function")
      return updateConversation(id, raw);
    if (raw && typeof raw.model === "object" && raw.model !== null)
      return updateConversation(id, raw, { modelPreferenceCurrent: nativeDirectoryLease });
    const store = context.store, c = store.conversation(string.parse(id));
    const current = lifecycleCurrent(c);
    const owner = context.activeAccount?.id;
    const environment = c.environment;
    const remote = environment?.kind === "ssh" || environment?.kind === "wsl" ? environment : undefined;
    const cwd = c.cwd;
    const valid = () => current() && nativeDirectoryLease() && !!owner &&
      !c.incognito && !c.archived && !c.codeNewTask &&
      sameEnvironment(c.environment, environment) && c.cwd === cwd &&
      (!!remote || onThisMachine(environment)) && c.worktree?.state !== "deleted" &&
      (!c.sessionAuthors || (c.sessionAuthors.ownerAccountUuid === owner &&
        c.sessionAuthors.viewerAccountUuid === owner));
    if (!cwd || !valid()) throw Error("This Code session cannot add folders right now.");
    const { additionalFolders } = z.strictObject({
      additionalFolders: z.array(remote ? remoteCodeDirectory : localCodeDirectory).min(1).max(20),
    }).parse(raw);
    const commit = (resolved: string[]) => {
      const existing = c.additionalFolders ?? [];
      const roots = [cwd, ...existing];
      if (!valid()) throw Error("This Code session changed while opening its folders.");
      const additions = [...new Set(resolved)].filter(folder => !roots.some(root => {
        if (!remote) return includesFolder(realFolder(root), folder);
        const relative = path.posix.relative(root, folder);
        return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
      }));
      if (!additions.length) return structuredClone(c);
      const folders = [...existing, ...additions];
      if (folders.length > 20) throw Error("A Code session can have up to 20 additional folders.");
      const scoped = additions.filter(folder => {
        try {
          if (remote) registryOf(context.engine)!.allowedFolder(folder, remote);
          else context.allowedFolder(folder);
          return false;
        }
        catch { return true; }
      });
      store.commitLocalCodeHistory(c, {
        additionalFolders: folders,
        codeSessionFolderGrants: [...(c.codeSessionFolderGrants ?? []), ...scoped],
      }, undefined, valid);
      context.push?.({ type: "conversation", conversation: structuredClone(c) });
      return structuredClone(c);
    };
    if (remote) {
      const registry = registryOf(context.engine);
      if (!registry) throw Error("This Code session's host is unavailable.");
      const engine = registry.running(c.id);
      if (engine?.pendingSend) throw Error("Wait for Code input to finish submitting before adding folders.");
      engine?.assertIdle(c.id);
      const workspace = registry.worktreeWorkspace(remote);
      const release = beginCodeSessionLifecycle(c);
      return Promise.all(additionalFolders.map(folder => workspace.resolveDirectory(folder)))
        .then(commit).finally(release);
    }
    const release = beginCodeSessionLifecycle(c);
    try {
      return commit(additionalFolders.map(resolveLocalCodeDirectory));
    } finally {
      release();
    }
  });
  handle("releaseRunner", async (id: unknown) =>
    context.engine.releaseRunner(string.parse(id)),
  );
  handle("discardIncognito", async (id: unknown, draft: unknown) => {
    const store = context.store, engine = context.engine;
    const selected = context.selectedAttachments, feedback = context.replyFeedback;
    const generation = context.accountGeneration?.();
    const conversationId = string.parse(id);
    const draftId = incognitoDraftId.optional().parse(draft);
    const c = store.conversations.find(value => value.id === conversationId);
    if (!c) {
      if (draftId) discardIncognitoUploads(store.root, selected, draftId);
      return;
    }
    if (!c.incognito) throw Error("Only incognito chats are discarded.");
    const current = () => context.store === store && context.engine === engine &&
      context.selectedAttachments === selected && context.accountRetiring !== true &&
      context.accountGeneration?.() === generation && store.conversations.includes(c);
    assertAccountOperationCurrent(current);
    if (c.turns.some((t) => t.status === "inProgress"))
      await engine.interrupt(c.id);
    assertAccountOperationCurrent(current);
    if (c.turns.some((t) => t.status === "inProgress"))
      throw Error("This conversation is still running.");
    if (engine.rpc && c.threadId)
      try {
        await engine.rpc.call("thread/archive", {
          threadId: c.threadId,
        });
      } catch {
        /* An ephemeral thread may have nothing to archive. */
      }
    if (
      c.mode === "code" &&
      !c.incognito &&
      c.cwd &&
      onThisMachine(c.environment)
    )
      for (const suggestion of c.backgroundTaskSuggestions ?? [])
        if (suggestion.cwd === c.cwd || suggestion.cwd === c.worktree?.path)
          new TaskBacklog(store.root).file(
            c.id,
            { ...suggestion, cwd: c.cwd },
            "orphaned",
          );
    assertAccountOperationCurrent(current);
    if (c.turns.some((t) => t.status === "inProgress"))
      throw Error("This conversation is still running.");
    discardIncognitoAttachments(store.root, c, store.conversations, selected);
    const attachments = [...c.turns, ...(c.savedBranches ?? []).flatMap(branch => branch.turns)].flatMap(turn => turn.attachments ?? []);
    const drafts = attachments.map(attachment => privateAttachmentDraft(store.root, attachment));
    for (const bucket of new Set([draftId, incognitoDraftId.safeParse(c.id).data, ...drafts].filter(id => id !== undefined)))
      discardIncognitoUploads(store.root, selected, bucket);
    store.conversations = store.conversations.filter(
      (value) => value.id !== c.id,
    );
    feedback.deleteConversation(c.id);
    coworkFolderGrants(store.root).forgetConversation(c.id);
    context.push?.({ type: "resync" });
  });
  handle(
    "setConversationWebSearch",
    async (
      id: unknown,
      value: unknown,
      selectedProviderId?: unknown,
      selectedModel?: unknown,
    ) => {
      const store = context.store;
      const account = context.activeAccount?.id;
      const generation = context.accountGeneration?.() ?? context.accountActivationIdentity;
      const conversation = store.conversation(string.parse(id));
      const engine = engineOf(conversation.id);
      const current = () => !context.accountRetiring && context.store === store &&
        engineOf(conversation.id) === engine && context.activeAccount?.id === account &&
        (context.accountGeneration?.() ?? context.accountActivationIdentity) === generation &&
        store.conversations.includes(conversation);
      const enabled = z.boolean().parse(value);
      const providerId =
        selectedProviderId === undefined
          ? conversation.providerId
          : string.parse(selectedProviderId);
      const model =
        selectedModel === undefined
          ? conversation.model
          : z.string().min(1).max(200).parse(selectedModel);
      if (enabled) {
        if (conversation.mode === "code")
          throw Error("This Web search control belongs to Chat and Cowork.");
        if (!context.engine.policy().webSearch)
          throw Error("Your administrator has turned off web search.");
        const provider = context.store.settings.providers.find(
          (item) => item.id === providerId,
        );
        if (!provider || modelProtocol(provider, model) !== "responses")
          throw Error(
            "Web search requires a Responses-compatible model service.",
          );
        if (
          provider.models.length &&
          !new Set([provider.model, ...provider.models]).has(model)
        )
          throw Error("This account cannot use the selected model.");
      }
      context.noActive();
      if (
        Boolean(conversation.webSearch) === enabled &&
        (!enabled ||
          (conversation.providerId === providerId &&
            conversation.model === model))
      )
        return conversation;
      const research = !enabled && !researchConnectorEnabled(
        store.settings, context.engine.policy(), conversation.connectorOverrides,
      ) ? undefined : conversation.research;
      try {
        await store.persistWebSearchPreference(conversation, {
          webSearch: enabled,
          research,
          providerId: enabled ? providerId : conversation.providerId,
          model: enabled ? model : conversation.model,
        }, current);
      } catch (error) {
        // The original control is optimistic. Only a known local write failure
        // has an unchanged authoritative value; never imply a cloud rollback.
        if (error instanceof WebSearchSaveError && current())
          context.push?.({ type: "conversation", conversation: structuredClone(conversation) });
        throw error;
      }
      await engine?.stop(current);
      await store.confirmConversationMetadata(conversation, current, true);
      assertAccountOperationCurrent(current);
      if (!!conversation.webSearch !== enabled)
        throw Error("The web search setting changed before the save could be confirmed.");
      const updated = structuredClone(conversation);
      context.push?.({ type: "conversation", conversation: updated });
      return updated;
    },
  );
  handle("reorderConversations", (raw: unknown) => {
    const input = z
      .object({
        sourceId: string,
        targetId: string.optional(),
        section: z.enum(["pinned", "recent"]),
        position: z.enum(["before", "after"]),
      })
      .parse(raw);
    context.store.conversations = reorderSidebarConversations(
      context.store.conversations,
      input.sourceId,
      input.targetId,
      input.section,
      input.position,
    );
    context.store.flush();
    return context.store.conversations;
  });
  const deleteConversation = async (
    id: unknown,
    discardWorktrees: ReadonlySet<CodeWorktree> = new Set(),
    deliveryCurrent?: () => boolean,
  ) => {
    const store = context.store, feedback = context.replyFeedback;
    const generation = context.accountGeneration?.();
    const c = store.conversation(string.parse(id));
    store.assertConversationProjectWritable(c.id);
    const localCode = desktopCode(c);
    const chatOrCowork = c.mode === "chat" || c.mode === "cowork";
    if (chatOrCowork && deletingConversations.has(c))
      throw Error("This conversation is already being deleted.");
    const localCurrent = localCode ? lifecycleCurrent(c) : undefined;
    const current = () => context.store === store && context.accountGeneration?.() === generation &&
      store.conversations.includes(c) && !c.turns.some(t => t.status === "inProgress") &&
      (!localCurrent || localCurrent()) && (!deliveryCurrent || deliveryCurrent());
    if (c.turns.some((t) => t.status === "inProgress"))
      throw new Error("Stop the task first.");
    assertAccountOperationCurrent(current);
    const release = localCode ? beginCodeSessionLifecycle(c) : () => {};
    if (chatOrCowork) deletingConversations.add(c);
    try {
      await context.closeTerminals?.(c.id);
      assertAccountOperationCurrent(current);
      const worktrees = conversationWorktrees(c);
      const remote = worktrees.length ? worktreeWorkspace(c) : undefined;
      if (remote) await connectWorktreeHost(c)?.catch(() => undefined);
      assertAccountOperationCurrent(current);
      // An SSH conversation's threads are on its host (archived there while
      // its engine runs).
      const engine = engineOf(c.id);
      const rpc = engine?.rpc;
      if (rpc)
        for (const threadId of new Set(
          [c.threadId, ...(c.savedBranches ?? []).map((b) => b.threadId)].filter(
            Boolean,
          ),
        ))
          try {
            await rpc.call("thread/archive", { threadId });
            assertAccountOperationCurrent(current);
          } catch { assertAccountOperationCurrent(current); }
      assertAccountOperationCurrent(current);
      if (localCode) store.commitLocalCodeLifecycle(c, null, current);
      else if (chatOrCowork) await store.persistConversationDeletion(c, current);
      else {
        store.conversations = store.conversations.filter((v) => v.id !== id);
        store.flush();
      }
      // Confirmed local removal must remain visible even if ancillary cleanup fails.
      if (localCode) context.push?.({ type: "resync" });
      try {
        feedback.deleteConversation(string.parse(id));
        coworkFolderGrants(store.root).forgetConversation(c.id);
      } catch (error) {
        if (!localCode && !chatOrCowork) throw error;
        console.error("Deleted session ancillary data needs cleanup.");
      }
      // Refresh other windows' lists, and release a session's keep-awake state.
      if (!localCode && (c.keepAwake || (!c.incognito && !c.deviceChatOrigin && (c.mode === "chat" || c.mode === "cowork"))))
        context.push?.({ type: "resync" });
      // Its worktree goes too unless it has changes; the branch stays.
      if (!localCode || remote || onThisMachine(c.environment)) {
        for (const worktree of worktrees) {
          if (worktree.state === "deleted") continue;
          listedDirty.delete(worktree);
          if (!localCode || !worktreeInUse(c, worktree)) {
            const discard = discardWorktrees.has(worktree);
            if (remote) await removeRemoteSessionWorktree(remote, worktree, discard, true).catch(() => undefined);
            else if (discard) await removeSessionWorktree(worktree, undefined, true);
            else void removeSessionWorktree(worktree).catch(() => undefined);
          }
        }
      }
      const pendingRemoteWorktree = c.remoteCodeWorktree?.plan;
      if (localCode && onThisMachine(c.environment) && !c.worktree &&
          pendingRemoteWorktree && !worktreeInUse(c, pendingRemoteWorktree))
        await cleanupRemoteCodeWorktree(pendingRemoteWorktree);
      if (localCode && onThisMachine(c.environment) && context.store === store &&
          context.accountGeneration?.() === generation) {
        const scratch = codeScratchWorkspaceRoot(c.cwd, context.engine.defaultWorkspace);
        if (scratch) {
          const root = realFolder(scratch);
          const inUse = store.conversations.some(other => onThisMachine(other.environment) &&
            [other.cwd, other.worktree?.origin, other.worktree?.path, ...(other.additionalFolders ?? [])]
              .some(folder => includesFolder(root, folder))) ||
            store.projects.some(project => onThisMachine(project.environment) && includesFolder(root, project.cwd));
          if (!inUse) await rm(scratch, { recursive: true, force: true }).catch(error =>
            console.error("Deleted Code scratch workspace could not be removed.", error),
          );
        }
      }
    } finally {
      if (chatOrCowork) deletingConversations.delete(c);
      release();
    }
  };
  handle("deleteConversation", (id: unknown, current?: unknown) =>
    deleteConversation(id, undefined, typeof current === "function" ? () => current() === true : undefined),
  );
  handle("officialCodeWorktreeLifecycle", async (raw: unknown) => {
    const request = codeWorktreeRequest.parse(raw);
    const store = context.store;
    const c = store.conversation(request.sessionId);
    const current = codeSessionCurrent(c);
    const worktrees = conversationWorktrees(c).filter(tree => tree.state !== "deleted");
    const remote = worktrees.length ? worktreeWorkspace(c) : undefined;
    if (!current()) throw Error("Code session not found");
    if (request.kind === "probe" || request.kind === "probeByFolder") {
      const selected = request.kind === "probe" ? worktrees.filter(tree => tree === c.worktree) : worktrees;
      const probes = await Promise.all(selected.map(async worktree => {
        const probe = remote
          ? await probeRemoteSessionWorktree(remote, worktree, worktree === c.worktree)
          : onThisMachine(c.environment) ? await probeSessionWorktree(worktree, worktree === c.worktree)
          : { folder: worktree.origin, worktreePath: worktree.path, unreadable: true as const,
              ...(worktree === c.worktree ? { primary: true } : {}) };
        assertAccountOperationCurrent(() => current() &&
          conversationWorktrees(c).includes(worktree) && worktree.state !== "deleted");
        if ("changes" in probe && probe.changes?.length) listedDirty.set(worktree, current);
        return probe;
      }));
      return request.kind === "probe" ? probes[0] ?? null : probes.length ? probes : null;
    }
    if (request.kind === "discardKept") {
      const kept = worktrees.filter(tree => tree.state === "kept");
      if (!kept.length || !c.archived) return { outcome: "not_kept" };
      if (!remote && !onThisMachine(c.environment)) return { outcome: "failed" };
      if (c.turns.some(turn => turn.status === "inProgress") || kept.some(tree => worktreeInUse(c, tree)))
        return { outcome: "busy" };
      const stillCurrent = lifecycleCurrent(c);
      assertAccountOperationCurrent(stillCurrent);
      const release = beginCodeSessionLifecycle(c);
      try {
        if (remote) await connectWorktreeHost(c)?.catch(() => undefined);
        assertAccountOperationCurrent(stillCurrent);
        for (const tree of kept) {
          listedDirty.delete(tree);
          const state = remote
            ? await removeRemoteSessionWorktree(remote, tree, true)
            : await removeSessionWorktree(tree, undefined, true);
          assertAccountOperationCurrent(() => stillCurrent() && conversationWorktrees(c).includes(tree));
          tree.state = state;
        }
        store.flush();
        context.push?.({ type: "conversation", conversation: structuredClone(c) });
        return { outcome: kept.every(tree => tree.state === "deleted") ? "discarded" : "failed" };
      } finally { release(); }
    }
    const discardWorktrees = new Set<CodeWorktree>();
    for (const folder of request.paths) {
      const worktree = worktrees.find(tree => tree.path === folder);
      if (!worktree || !listedDirty.get(worktree)?.())
        throw Error(`Code ${request.kind} options are not supported yet: the session worktree was not listed with changes.`);
      discardWorktrees.add(worktree);
    }
    return request.kind === "archive"
      ? updateConversation(c.id, { archived: true }, { discardWorktrees, cleanupWorktree: request.cleanupWorktree })
      : deleteConversation(c.id, discardWorktrees);
  });
  /** Archive or unarchive a session's worktree, then tell the windows. */
  const settleWorktree = async (
    c: Conversation,
    worktree: CodeWorktree,
    archived: boolean,
    merged = false,
    discardChanges = false,
  ) => {
    const store = context.store, generation = context.accountGeneration?.();
    const current = () => context.store === store &&
      context.accountGeneration?.() === generation && store.conversations.includes(c) &&
      conversationWorktrees(c).includes(worktree) && c.archived === archived;
    if (!current()) return;
    const remote = worktreeWorkspace(c);
    if (!remote && !onThisMachine(c.environment)) return;
    try {
      if (archived) {
        if (worktree.state === "deleted" || (worktree.state === "kept" && !discardChanges)) return;
        const state = desktopCode(c) && worktreeInUse(c, worktree)
          ? "kept" : remote ? await removeRemoteSessionWorktree(remote, worktree, discardChanges)
          : await removeSessionWorktree(worktree, undefined, discardChanges);
        if (!current()) return;
        worktree.state = state;
        // Archived because its pull request merged: the branch goes too.
        if (merged && worktree.state === "deleted") {
          await deleteMergedBranch(worktree, undefined, tip => {
            if (!current()) return false;
            worktree.archivedBranchTip = tip;
            store.flush();
            return current();
          });
          if (!current()) return;
        }
      } else {
        if (worktree.state !== "deleted") {
          delete worktree.state;
          return;
        }
        await restoreSessionWorktree(worktree);
        if (!current()) return;
        delete worktree.state;
      }
    } catch {
      return;
    }
    if (!current()) return;
    store.flush();
    if (!current()) return;
    context.push?.({ type: "conversation", conversation: structuredClone(c) });
  };
}

