import { z } from "zod";
import { remoteFolderValid, remoteFolderUsesWorktree } from "../../shared/remote-devices";
import {
  remoteCodeArchivedInventoryPath,
  remoteCodeEnvironmentId,
  remoteCodeEnvironmentTarget,
  remoteCodeInventoryPath,
  remoteCodeRequest,
  remoteCodeSessionId,
  remoteCodeSessionKey,
} from "../../shared/official-remote-code";
import {
  officialCodeHistoryRequest,
  officialCodeMarkRead,
  officialCodeMutation,
  officialCodePermission,
  officialCodePermissionName,
  officialCodeSessionCreation,
  officialCodeSessionTitle,
} from "../../shared/official-code-history";
import {
  officialCodeApprovalEvent,
  officialCodeLegacyApprovalEvent,
} from "../../shared/official-code-approval";
import {
  officialCodeEvent,
  officialCodeFollowupPath,
  officialCodeControlContentType,
  officialCodeReceiptPath,
} from "../../shared/official-code-followup";
import {
  applyOfficialCodeViewerLease,
  officialCodeViewerBody,
  officialCodeViewerRefreshSeconds,
  officialCodeViewerSession,
} from "../../shared/official-code-viewers";
import { codeEffortLevels } from "../../shared/code-effort";
import { CodeUltracodeUnavailable } from "../../shared/code-session-settings";
import {
  isConversationModel,
  type ModelCatalog,
} from "../../shared/model-catalog-api";
import { officialContextUsage } from "../../shared/official-code-context";
import {
  interruptTargetSchema,
  type InterruptTargetResult,
} from "../../shared/interrupt-target";
import type {
  Approval,
  Conversation,
  PublicAccount,
  Settings,
} from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { codeSandboxFor } from "../../shared/sandbox-policy";
import { newConversation, type SendInput } from "../engine/new-conversation";
import {
  codeModelChoice,
  type CodeModelPreference,
} from "../ipc/code-model-preferences";
import {
  cloudCodeSession,
  codeStopTarget,
  eventPage,
} from "../official-ui/api/cloud-code-history";
import { officialCodeApprovalResult } from "../official-ui/api/cloud-code-approval";
import { reachable } from "./device-methods";

const config = z.strictObject({
  sources: z.tuple([]).optional(),
  outcomes: z.tuple([]).optional(),
  permission_mode: officialCodePermission.optional(),
  model: z.string().min(1).max(200).optional(),
  effort_level: z.enum(codeEffortLevels).nullable().optional(),
});
const creation = z.strictObject({
  title: z.string().max(200).optional(),
  environment_id: z.string(),
  config,
  tags: z.array(z.literal("remote-control-app")).optional(),
  events: z.tuple([]),
});
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const titleUpdate = z.strictObject({ title: officialCodeSessionTitle });
const emptyMutation = z.strictObject({});
const renameReceipt = z.strictObject({
  session_id: z.string().optional(),
  events: z.tuple([
    z.strictObject({
      payload: z.strictObject({
        type: z.literal("control_request"),
        uuid: z.uuid().optional(),
        request_id: requestId,
        request: z.strictObject({
          subtype: z.literal("rename_session"),
          title: officialCodeSessionTitle,
        }),
      }),
    }),
  ]),
});
const user = z.looseObject({
  type: z.literal("user"),
  uuid: z.uuid(),
  session_id: z.string().optional(),
  message: z.strictObject({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z
        .strictObject({ type: z.literal("text"), text: z.string() })
        .array()
        .max(128),
    ]),
  }),
  file_attachments: z.tuple([]).optional(),
});
const control = z.looseObject({
  type: z.literal("control_request"),
  request_id: requestId,
  request: z.discriminatedUnion("subtype", [
    z.strictObject({
      subtype: z.literal("set_permission_mode"),
      mode: officialCodePermission,
    }),
    z.strictObject({
      subtype: z.literal("set_model"),
      model: z.string().min(1).max(200),
    }),
    z.strictObject({
      subtype: z.literal("apply_flag_settings"),
      settings: z
        .strictObject({
          effortLevel: z.enum(codeEffortLevels).nullable().optional(),
          ultracode: z.boolean().optional(),
          fastMode: z.boolean().optional(),
        })
        .refine(
          ({ effortLevel, ultracode, fastMode }) =>
            effortLevel !== undefined ||
            ultracode !== undefined ||
            fastMode !== undefined,
        ),
    }),
    z.strictObject({
      subtype: z.literal("interrupt"),
      turn_target: interruptTargetSchema.optional(),
      starting_input_uuid: z.uuid().optional(),
    }),
    z.strictObject({ subtype: z.literal("initialize") }),
    z.strictObject({
      subtype: z.literal("get_context_usage"),
      detail: z.enum(["summary", "full"]).optional(),
    }),
  ]),
});
const events = z.looseObject({
  session_id: z.string().optional(),
  events: z
    .array(
      z.union([
        user,
        control,
        z
          .looseObject({ payload: z.union([user, control]) })
          .transform(({ payload }) => payload),
      ]),
    )
    .min(1)
    .max(4),
});

type SessionPatch = {
  title?: string;
  titleSource?: "user";
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
  providerId?: string;
  model?: string;
  codePermissionMode?: Conversation["codePermissionMode"];
};
type CodeFlagChoice = Pick<CodeModelPreference, "effort" | "codeUltracode">;
export type RemoteCodeHost = {
  account(): PublicAccount;
  device(): string;
  settings(): Settings;
  directory(): string;
  viewerScope(): object;
  conversations(): Conversation[];
  approvals(): Approval[];
  modelCatalog(providerId: string): ModelCatalog | null;
  codeUltracodeAvailable(conversation: Conversation): boolean;
  assertFolder(cwd: string): void;
  create(conversation: Conversation): void;
  send(
    input: SendInput,
    eventId: string,
    current: () => boolean,
  ): Promise<unknown>;
  update(id: string, patch: SessionPatch): Promise<unknown>;
  delete(id: string, current: () => boolean): Promise<unknown>;
  saveCodeFlags(
    conversation: Conversation,
    choice: CodeFlagChoice,
    current: () => boolean,
  ): Promise<unknown>;
  interrupt(
    id: string,
    expected: NonNullable<ReturnType<typeof codeStopTarget>>["target"],
  ): Promise<InterruptTargetResult>;
  approve(id: Approval["id"], result: unknown): Promise<unknown>;
};

const answer = (status: number, value: unknown) => ({ status, value });
const controlReply = (requestId: string, response: object) => ({
  ...answer(200, { requestId, response }),
  contentType: officialCodeControlContentType,
});
const error = (status: number, message: string) =>
  answer(status, {
    type: "error",
    error: {
      type: status === 404 ? "not_found_error" : "invalid_request_error",
      message,
    },
  });
const sessionMissing = () =>
  error(404, "Code session not found on this computer.");
const validSession = (
  conversation: Conversation | undefined,
  owner: string,
): conversation is Conversation =>
  reachable(conversation) &&
  conversation.mode === "code" &&
  !conversation.cloudHosted &&
  !conversation.cloudEnvironmentId &&
  !conversation.linkedComputerId &&
  (conversation.archived || conversation.worktree?.state !== "deleted") &&
  (!conversation.sessionAuthors ||
    (conversation.sessionAuthors.ownerAccountUuid === owner &&
      conversation.sessionAuthors.viewerAccountUuid === owner)) &&
  remoteCodeSessionId(remoteCodeSessionKey(conversation.id)) ===
    conversation.id;

function modelChoice(
  settings: Settings,
  model?: string,
  currentProvider?: string,
) {
  if (model && !isConversationModel(model)) return;
  const preferred = currentProvider ?? settings.activeProviderId;
  const providers = settings.providers
    .filter(({ id }) => id === preferred)
    .concat(settings.providers.filter(({ id }) => id !== preferred));
  const provider = providers.find(
    (p) => !model || p.model === model || p.models.includes(model),
  );
  return provider && { provider, model: model || provider.model };
}

function assertPermission(
  settings: Settings,
  cwd: string | undefined,
  mode: Conversation["codePermissionMode"],
) {
  if (
    mode === "bypass" &&
    codeSandboxFor(
      { ...settings, codeSandbox: "danger-full-access", codePlanMode: false },
      cwd,
    ) !== "danger-full-access"
  )
    throw Error(
      "Allow bypass permissions for this folder on your computer first.",
    );
}

const receiptPath =
  /^\/v1\/code\/sessions\/(?:session|cse)_[a-f0-9]{32}(?:\/.*)?$/;

export function createOfficialRemoteCodeHost(host: RemoteCodeHost) {
  const sending = new Map<string, Set<string>>();
  const firstWorktreeSending = new Set<string>();
  const viewersByScope = new WeakMap<object, Map<string, Map<string, number>>>();
  const summary = (conversation: Conversation, directories: string[]) => {
    const { id, cwd, worktree } = conversation;
    const directory = worktree?.origin ?? cwd;
    return {
      ...cloudCodeSession(
        conversation,
        host.account().id,
        undefined,
        false,
        () => host.codeUltracodeAvailable(conversation),
      ),
      id: "session_" + remoteCodeSessionKey(id),
      environment_kind: "bridge",
      environment_id: remoteCodeEnvironmentId(
        host.device(),
        directory && directories.includes(directory) ? directory : undefined,
      ),
      connection_status: "connected",
    };
  };
  const readSession = (conversation: Conversation, directories: string[]) => ({
    ...summary(conversation, directories),
    claudex_stop_target: codeStopTarget(conversation) ?? null,
  });
  const requireCurrent = (current: () => boolean) => {
    if (!current())
      throw new DOMException("Device access changed. Try again.", "AbortError");
  };
  return async (
    raw: unknown,
    current: () => boolean,
    capacity: () => { active: number; max: number },
  ) => {
    requireCurrent(current);
    const parsed = remoteCodeRequest.safeParse(raw);
    if (!parsed.success) return error(400, "Invalid Remote Control request.");
    const { method, path, body } = parsed.data;
    const url = URL.parse(path, "http://localhost");
    if (url?.origin !== "http://localhost")
      return error(400, "Invalid Remote Control request.");
    const { pathname, search } = url;
    const settings = host.settings();
    const owner = host.account().id;
    const directories = preference(settings, "remoteFolders").filter(
      remoteFolderValid,
    );
    const archivedInventory =
      pathname + search === remoteCodeArchivedInventoryPath;
    if (method === "GET" && pathname === remoteCodeInventoryPath) {
      const legacy = !search || archivedInventory;
      const query = new URLSearchParams(search);
      const page =
        !legacy &&
        (query.has("limit") || query.has("cursor")) &&
        [...query.keys()].every((key) =>
          ["limit", "cursor", "statuses", "tags"].includes(key),
        )
          ? officialCodeHistoryRequest(method, pathname, search)
          : undefined;
      if (!legacy && page?.kind !== "list")
        return error(404, "Remote Control request not found.");

      const rows = host
        .conversations()
        .filter((c) => {
          if (!validSession(c, owner)) return false;
          if (page?.kind !== "list") return !!c.archived === archivedInventory;
          const status = c.archived ? "archived" : "active";
          return (
            (!page.statuses.length || page.statuses.includes(status)) &&
            page.tags.every((tag) => tag === "ui:pinned" && c.pinned)
          );
        })
        .sort(
          (a, b) =>
            b.updatedAt - a.updatedAt ||
            (legacy ? 0 : a.id.localeCompare(b.id)),
        );

      let start = 0;
      if (page?.kind === "list" && page.cursor) {
        const key = page.cursor.replace(/^(?:session|cse)_/, "");
        start =
          rows.findIndex((row) => remoteCodeSessionKey(row.id) === key) + 1;
        if (!start)
          return error(404, "Code session cursor is no longer available.");
      }
      const end = start + (page?.kind === "list" ? page.limit : 100);
      const sessions = rows
        .slice(start, end)
        .map((c) => summary(c, directories));
      const { active, max } = capacity();
      return answer(200, {
        directories,
        capacity: max,
        active,
        sessions,
        ...(!legacy && {
          next_cursor: end < rows.length ? (sessions.at(-1)?.id ?? null) : null,
        }),
      });
    }
    if (officialCodeSessionCreation(method, pathname) && !search) {
      const input = creation.safeParse(body);
      if (!input.success)
        return error(400, "Unsupported Remote Control session configuration.");
      const target = remoteCodeEnvironmentTarget(input.data.environment_id);
      if (
        target?.device !== host.device() ||
        !target.directory ||
        !directories.includes(target.directory)
      )
        return error(
          403,
          "Add this folder to Remote Control on your computer first.",
        );
      const { active, max } = capacity();
      if (active >= max)
        return error(
          409,
          "This computer is at capacity. Wait for a running session to finish.",
        );
      const { directory } = target;
      host.assertFolder(directory);
      const choice = modelChoice(settings, input.data.config.model);
      if (!choice)
        return error(
          400,
          "The selected model is unavailable on this computer.",
        );
      const { provider, model } = choice;
      const mode = input.data.config.permission_mode ?? "manual";
      assertPermission(settings, directory, mode);
      const conversation = newConversation(
        {
          mode: "code",
          codePermissionMode: mode,
          codeRemoteControlAtStart: true,
          text: "",
          attachments: [],
          providerId: provider.id,
          model,
          effort: input.data.config.effort_level ?? undefined,
        },
        provider,
        directory,
        settings,
      );
      if (remoteFolderUsesWorktree(settings, directory))
        conversation.remoteCodeWorktree = { origin: directory };
      conversation.remoteControlStarted = true;
      conversation.title = input.data.title || "New Code session";
      if (input.data.title) conversation.titleSetByUser = true;
      conversation.effort = input.data.config.effort_level ?? undefined;
      host.create(conversation);
      return answer(200, { session: summary(conversation, directories) });
    }
    if (
      !receiptPath.test(pathname) &&
      !officialCodeFollowupPath(method, pathname)
    )
      return error(404, "Remote Control request not found.");
    const read = officialCodeHistoryRequest(method, pathname, search);
    const receipt = officialCodeReceiptPath(method, pathname);
    const mutation = officialCodeMutation(method, pathname);
    const followup = officialCodeFollowupPath(method, pathname);
    const markRead = officialCodeMarkRead(method, pathname);
    const viewer = officialCodeViewerSession(method, pathname, search);
    const key =
      read && "key" in read
        ? read.key
        : ((receipt ?? mutation ?? followup)?.key ?? markRead ?? viewer);
    const id = key && remoteCodeSessionId(key);
    const conversation = id
      ? host.conversations().find((c) => c.id === id)
      : undefined;
    if (!validSession(conversation, owner)) return sessionMissing();
    if (viewer) {
      const input = officialCodeViewerBody.safeParse(body);
      if (!input.success) return error(400, "Invalid Code viewer presence.");
      const scope = host.viewerScope();
      const sessions = viewersByScope.get(scope) ?? new Map();
      applyOfficialCodeViewerLease(sessions, viewer, input.data);
      viewersByScope.set(scope, sessions);
      return answer(200, {
        refresh_after_seconds: officialCodeViewerRefreshSeconds,
      });
    }
    const sessionCurrent = () =>
      current() &&
      host.account().id === owner &&
      validSession(conversation, owner) &&
      host.conversations().includes(conversation);
    const active = () => !conversation.archived && sessionCurrent();
    const session = summary(conversation, directories);
    const matchesSession = (wire: string | undefined) =>
      wire === undefined || wire.replace(/^cse_/, "session_") === session.id;
    const approvals = host
      .approvals()
      .filter((a) => a.conversationId === conversation.id);
    if (read?.kind === "session")
      return answer(200, { session: readSession(conversation, directories) });
    if (read?.kind === "events" || read?.kind === "stream") {
      const page = eventPage(
        conversation,
        read,
        host.account().id,
        {
          account: host.account,
          settings: host.settings,
          stateDirectory: host.directory,
        },
        undefined,
        approvals,
        undefined,
        undefined,
        undefined,
        undefined,
        session,
      );
      return page
        ? answer(200, page)
        : error(
            page === null ? 413 : 410,
            "This Code history page is unavailable.",
          );
    }
    if (receipt) {
      const previous = officialCodeEvent(conversation.turns, receipt.eventId);
      return previous &&
        (previous.kind === "steer" || !previous.turn.id.startsWith("pending-"))
        ? answer(204, null)
        : sessionMissing();
    }
    if (mutation?.kind === "metadata") {
      const input = titleUpdate.safeParse(body);
      if (!input.success) return error(400, "Invalid Code session title.");
      const { title } = input.data;
      try {
        await host.update(conversation.id, { title, titleSource: "user" });
        requireCurrent(sessionCurrent);
      } catch {
        return error(
          409,
          "The Code session title save could not be confirmed. Reopen the session.",
        );
      }
      return answer(200, { session: summary(conversation, directories) });
    }
    if (mutation?.kind === "delete") {
      if (!emptyMutation.safeParse(body).success)
        return error(400, "Invalid Code session deletion.");
      const idle = () =>
        !sending.has(conversation.id) &&
        !conversation.codeNewTask &&
        !conversation.turns.some((turn) => turn.status === "inProgress");
      if (!idle())
        return error(
          409,
          "Finish or stop the Code task before deleting this session.",
        );
      try {
        await host.delete(conversation.id, () => sessionCurrent() && idle());
      } catch {
        return error(
          409,
          "The Code session deletion could not be confirmed. Reopen the session.",
        );
      }
      return answer(200, {});
    }
    if (mutation?.kind === "archive") {
      const stop = codeStopTarget(conversation);
      if (stop) await host.interrupt(conversation.id, stop.target);
      requireCurrent(current);
      await host.update(conversation.id, { archived: true });
      return answer(200, { session: summary(conversation, directories) });
    }
    if (mutation?.kind === "unarchive") {
      await host.update(conversation.id, { archived: false });
      return answer(200, { session: summary(conversation, directories) });
    }
    if (markRead && !search) {
      if (conversation.unread)
        await host.update(conversation.id, { unread: false });
      return answer(204, null);
    }
    if (!followup)
      return error(
        501,
        "This Code action is unavailable through Remote Control.",
      );
    const rename = renameReceipt.safeParse(body);
    if (rename.success) {
      if (!matchesSession(rename.data.session_id))
        return error(
          400,
          "This title confirmation belongs to another Code session.",
        );
      const { title } = rename.data.events[0].payload.request;
      return conversation.titleSetByUser && conversation.title === title
        ? answer(200, { events: [] })
        : error(409, "The Code session title changed. Reopen the session.");
    }
    if (!active())
      return error(409, "This Code session is no longer available.");
    const approval = officialCodeApprovalEvent.safeParse(body);
    const legacyApproval = officialCodeLegacyApprovalEvent.safeParse(body);
    if (approval.success || legacyApproval.success) {
      if (
        !matchesSession(
          approval.success
            ? approval.data.session_id
            : legacyApproval.data?.session_id,
        )
      )
        return error(400, "This approval belongs to another Code session.");
      const reply = approval.success
        ? approval.data.events[0].payload.response
        : legacyApproval.data?.events[0].response;
      if (!reply) return error(400, "Invalid Code approval.");
      const result = officialCodeApprovalResult(
        conversation,
        approvals,
        reply,
        settings.mcpServers,
        true,
      );
      if (result.kind !== "ready")
        return error(409, "This approval is no longer available.");
      await host.approve(result.id, result.response);
      return answer(200, { accepted: true });
    }
    const batch = events.safeParse(body);
    if (!batch.success || !matchesSession(batch.data.session_id))
      return error(400, "Unsupported Remote Control event.");
    if (batch.data.events.filter(({ type }) => type === "user").length > 1)
      return error(400, "Send one Code message at a time.");
    if (
      batch.data.events.some(
        (entry) =>
          entry.type === "control_request" &&
          entry.request.subtype === "apply_flag_settings" &&
          entry.request.settings.fastMode === true,
      )
    )
      return error(409, "Fast mode is unavailable on this computer.");
    for (const entry of batch.data.events) {
      requireCurrent(active);
      if (entry.type === "user") {
        if (!matchesSession(entry.session_id))
          return error(400, "This message belongs to another Code session.");
        const { content } = entry.message;
        const text =
          typeof content === "string"
            ? content
            : content.map(({ text }) => text).join("\n");
        if (!text.trim() || text.length > 200_000)
          return error(400, "Write a message first.");
        const previous = officialCodeEvent(conversation.turns, entry.uuid);
        if (previous) {
          if (!conversation.remoteCodeWorktree || previous.kind === "steer" ||
              !previous.turn.id.startsWith("pending-"))
            continue;
          return error(409, previous.turn.status === "inProgress"
            ? "This message is still being sent."
            : previous.turn.remoteCodeDispatchState === "preparing"
              ? "This message did not finish starting. Send a new message to retry."
              : "This message may have been sent. Check the session before retrying.");
        }
        const { active: running, max } = capacity();
        if (
          running + sending.size >= max &&
          conversation.turns.at(-1)?.status !== "inProgress"
        )
          return error(
            409,
            "This computer is at capacity. Wait for a running session to finish.",
          );
        const activeInputs = sending.get(conversation.id) ?? new Set<string>();
        const firstWorktree = !!conversation.remoteCodeWorktree && !conversation.worktree;
        if (activeInputs.has(entry.uuid) || firstWorktreeSending.has(conversation.id) ||
            (firstWorktree && activeInputs.size))
          return error(409, "This message is still being sent.");
        if (firstWorktree) firstWorktreeSending.add(conversation.id);
        const initiatingIntent = conversation.remoteCodeWorktree &&
          !conversation.turns.some(turn => !turn.id.startsWith("pending-"))
          ? conversation.remoteCodeWorktree : undefined;
        sending.set(conversation.id, activeInputs);
        activeInputs.add(entry.uuid);
        try {
          await host.send(
            {
              conversationId: conversation.id,
              mode: "code",
              text,
              attachments: [],
              providerId: conversation.providerId,
              model: conversation.model,
              effort: conversation.effort,
            },
            entry.uuid,
            () => {
              if (!active()) return false;
              if (!initiatingIntent) return true;
              if (conversation.remoteCodeWorktree !== initiatingIntent ||
                  (conversation.worktree?.origin ?? conversation.cwd) !== initiatingIntent.origin ||
                  !preference(host.settings(), "remoteFolders").filter(remoteFolderValid).includes(initiatingIntent.origin)) return false;
              try { host.assertFolder(initiatingIntent.origin); return true; } catch { return false; }
            },
          );
        } finally {
          activeInputs.delete(entry.uuid);
          if (firstWorktree) firstWorktreeSending.delete(conversation.id);
          if (!activeInputs.size) sending.delete(conversation.id);
        }
        if (conversation.remoteCodeWorktree) {
          const sent = officialCodeEvent(conversation.turns, entry.uuid);
          if (!sent) return error(409, "This message did not finish starting.");
          if (sent.kind === "turn" && sent.turn.id.startsWith("pending-"))
            return error(409, sent.turn.error || "This message has not finished starting.");
        }
        continue;
      }
      const request = entry.request;
      switch (request.subtype) {
        case "set_permission_mode":
          assertPermission(settings, conversation.cwd, request.mode);
          await host.update(conversation.id, {
            codePermissionMode: request.mode,
          });
          break;
        case "set_model": {
          const choice = modelChoice(
            settings,
            request.model,
            conversation.providerId,
          );
          if (!choice)
            return error(
              400,
              "The selected model is unavailable on this computer.",
            );
          if (
            choice.provider.id !== conversation.providerId ||
            choice.model !== conversation.model
          )
            await host.update(conversation.id, {
              providerId: choice.provider.id,
              model: choice.model,
            });
          break;
        }
        case "apply_flag_settings": {
          const { effortLevel, ultracode } = request.settings;
          let effort = effortLevel ?? undefined;
          if (effortLevel === null) {
            const item = host
              .modelCatalog(conversation.providerId)
              ?.items.find(({ id }) => id === conversation.model);
            if (!item) effort = settings.codeEffort;
            else if (item.efforts?.length)
              effort = codeModelChoice(item, conversation.effort, settings.codeEffort, {
                kind: "effort",
                value: null,
              }).effort;
          }
          if (effort === undefined && ultracode === undefined) break;
          try {
            await host.saveCodeFlags(
              conversation,
              {
                ...(effort !== undefined && { effort }),
                ...(ultracode !== undefined && { codeUltracode: ultracode }),
              },
              active,
            );
          } catch (cause) {
            if (cause instanceof CodeUltracodeUnavailable)
              return error(409, cause.message);
            throw cause;
          }
          break;
        }
        case "interrupt": {
          const currentStop = codeStopTarget(conversation);
          if (
            request.starting_input_uuid &&
            (request.turn_target ||
              currentStop?.promptUuid !== request.starting_input_uuid)
          )
            return error(409, "The running Code input changed.");
          const stop = request.turn_target ?? currentStop?.target;
          if (!stop) return error(409, "The running Code input changed.");
          const result = await host.interrupt(conversation.id, stop);
          if (result.status === "mismatch")
            return error(409, "The running Code input changed.");
          return answer(200, {
            events: [],
            ...(request.starting_input_uuid &&
              "kind" in stop && {
                cancelled_start: request.starting_input_uuid,
              }),
          });
        }
        case "initialize":
          return controlReply(entry.request_id, {
            commands: [],
            agents: [],
            models: [
              {
                value: conversation.model,
                displayName: conversation.model,
                description: "",
              },
            ],
            current_permission_mode: officialCodePermissionName(
              conversation.codePermissionMode ?? "manual",
            ),
          });
        case "get_context_usage":
          return controlReply(
            entry.request_id,
            officialContextUsage(conversation) ?? {},
          );
      }
    }
    return answer(200, { accepted: true });
  };
}
