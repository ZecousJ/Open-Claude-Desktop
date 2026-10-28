import { string } from "./conversations";
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
import { modelProtocol } from "../../shared/provider-routes";
import { researchConnectorEnabled } from "../../shared/research";
import { reorderSidebarConversations } from "../../shared/conversation-order";
import {
  removeSessionWorktree,
  deleteMergedBranch,
  restoreSessionWorktree,
} from "../git/code-worktree";
import type { Conversation } from "../../shared/types";
import type { Context, Handle } from "./conversations";
import type { Engine } from "../engine/engine";

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
  handle("updateConversation", (id: any, raw: any) => {
    const c = context.store.conversation(string.parse(id));
    const patch = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
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
        connectorOverrides: connectorOverridesInput.optional(),
        connectorToolOverrides: connectorToolOverridesInput.optional(),
        toolSearchMode: z.enum(["on", "off"]).optional(),
        remoteControl: z.boolean().optional(),
        codePermissionMode: z
          .enum(["auto", "manual", "acceptEdits", "plan", "bypass"])
          .optional(),
        keepAwake: z.boolean().optional(),
        prMerged: z.boolean().optional(),
        prAutoFix: z
          .object({ ci: z.boolean(), comments: z.boolean() })
          .optional(),
        prAutoArchive: z.boolean().optional(),
        providerId: z.string().min(1).max(200).optional(),
        model: z.string().min(1).max(200).optional(),
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
    if (patch.connectorToolOverrides !== undefined) {
      if (
        Object.keys(patch).some(
          (key) =>
            !["connectorOverrides", "connectorToolOverrides"].includes(key),
        )
      )
        throw Error("Update conversation tools separately.");
      if (c.turns.some((turn) => turn.status === "inProgress"))
        throw Error("Cannot modify connectors while message is processing");
      if (c.incognito && c.threadId)
        throw Error("Start a new incognito chat to change its tools.");
      for (const name of Object.keys(patch.connectorToolOverrides))
        if (!Object.hasOwn(context.store.settings.mcpServers, name))
          throw Error("This MCP server no longer exists.");
      const next = {
        ...c,
        connectorToolOverrides: patch.connectorToolOverrides,
        ...(patch.connectorOverrides
          ? { connectorOverrides: patch.connectorOverrides }
          : {}),
      };
      if (!c.incognito)
        context.store.write(
          "conversations.json",
          context.store.conversations
            .filter((item) => !item.incognito)
            .map((item) => (item === c ? next : item)),
        );
      c.connectorToolOverrides = next.connectorToolOverrides;
      if (patch.connectorOverrides)
        c.connectorOverrides = next.connectorOverrides;
      context.push?.({
        type: "conversation",
        conversation: structuredClone(c),
      });
      return structuredClone(c);
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
    if (patch.model !== undefined) {
      // "Change model": Code sessions only, a model the service offers, applied
      // from the next message. The engine is not stopped, so a running turn
      // finishes on the old model.
      if (c.mode !== "code" || c.incognito)
        throw Error("Only a Code session's model can be changed.");
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
    if (prAutoArchive !== undefined && c.mode === "code")
      c.prAutoArchive = prAutoArchive;
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
    Object.assign(c, rest);
    // A session's own worktree goes with archiving when it has no changes
    // (kept otherwise), and comes back from its branch on unarchiving.
    if (c.worktree && patch.archived !== undefined)
      void settleWorktree(c, patch.archived, prMerged === true);
    if (patch.projectId === null) c.projectId = undefined;
    if (patch.unread === false) {
      delete c.unread;
      context.scheduler?.markConversationRead(c.id);
    }
    context.store.flush();
    // The account's other windows and devices follow.
    context.push?.({ type: "conversation", conversation: structuredClone(c) });
    return c;
  });
  handle("releaseRunner", async (id: unknown) =>
    context.engine.releaseRunner(string.parse(id)),
  );
  handle("discardIncognito", async (id: any) => {
    const c = context.store.conversations.find(
      (value) => value.id === string.parse(id),
    );
    if (!c) return;
    if (!c.incognito) throw Error("Only incognito chats are discarded.");
    if (c.turns.some((t) => t.status === "inProgress"))
      await context.engine.interrupt(c.id).catch(() => {});
    if (context.engine.rpc && c.threadId)
      try {
        await context.engine.rpc.call("thread/archive", {
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
          new TaskBacklog(context.store.root).file(
            c.id,
            { ...suggestion, cwd: c.cwd },
            "orphaned",
          );
    context.store.conversations = context.store.conversations.filter(
      (value) => value.id !== c.id,
    );
    context.replyFeedback.deleteConversation(c.id);
    coworkFolderGrants(context.store.root).forgetConversation(c.id);
  });
  handle(
    "setConversationWebSearch",
    async (
      id: unknown,
      value: unknown,
      selectedProviderId?: unknown,
      selectedModel?: unknown,
    ) => {
      const conversation = context.store.conversation(string.parse(id));
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
      conversation.webSearch = enabled;
      if (
        !enabled &&
        !researchConnectorEnabled(
          context.store.settings,
          context.engine.policy(),
          conversation.connectorOverrides,
        )
      )
        delete conversation.research;
      if (enabled) {
        conversation.providerId = providerId;
        conversation.model = model;
      }
      context.store.flush();
      await context.engine.stop();
      return conversation;
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
  handle("deleteConversation", async (id: any) => {
    const c = context.store.conversation(string.parse(id));
    if (c.turns.some((t) => t.status === "inProgress"))
      throw new Error("Stop the task first.");
    await context.closeTerminals?.(c.id);
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
        } catch {}
    context.store.conversations = context.store.conversations.filter(
      (v) => v.id !== id,
    );
    context.store.flush();
    context.replyFeedback.deleteConversation(string.parse(id));
    coworkFolderGrants(context.store.root).forgetConversation(c.id);
    // A session that held the computer awake lets it sleep again.
    if (c.keepAwake) context.push?.({ type: "resync" });
    // Its worktree goes too unless it has changes; the branch stays.
    if (c.worktree && c.worktree.state !== "deleted")
      void removeSessionWorktree(c.worktree).catch(() => undefined);
  });
  /** Archive or unarchive a session's worktree, then tell the windows. */
  const settleWorktree = async (
    c: Conversation,
    archived: boolean,
    merged = false,
  ) => {
    const worktree = c.worktree!;
    try {
      if (archived) {
        if (worktree.state) return;
        worktree.state = await removeSessionWorktree(worktree);
        // Archived because its pull request merged: the branch goes too.
        if (merged && worktree.state === "deleted")
          await deleteMergedBranch(worktree);
      } else {
        if (worktree.state !== "deleted") {
          delete worktree.state;
          return;
        }
        await restoreSessionWorktree(worktree);
        delete worktree.state;
      }
    } catch {
      return;
    }
    context.store.flush();
    context.push?.({ type: "conversation", conversation: structuredClone(c) });
  };
}
