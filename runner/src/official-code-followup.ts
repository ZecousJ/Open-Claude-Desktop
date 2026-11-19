import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageType } from "../../electron/artifacts/generated-blobs";
import { assertCodeSessionSendAvailable, codeSessionLifecyclePending } from "../../electron/conversations/code-lifecycle-guard";
import { interruptExpectedTurn } from "../../electron/conversations/interrupt-target";
import {
  CodeRunAdmissionError,
  CodeSendCancelled,
  CodeSendStart,
} from "../../electron/engine/code-send-start";
import { CapacityError } from "./dispatcher-support";
import { storeOfficialAttachments } from "../../electron/ipc/official-attachments";
import { readOwnedAttachment } from "../../electron/ipc/owned-turn-attachment";
import { attachmentRefusal } from "../../shared/client-policy-rules";
import { CodeUltracodeUnavailable } from "../../shared/code-session-settings";
import { codeEffortInput, codeModelChoice, readCodeModelPreference, saveCodeModelPreference } from "../../electron/ipc/code-model-preferences";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { isAcceptedCodeCompaction } from "../../shared/agent-api";
import { parseSkillReferences, skillReferencesSchema } from "../../shared/skill-references";
import { respondOfficialCodeCommand } from "./official-code-command-approvals";
import type { Attachment, Conversation } from "../../shared/types";
import { z } from "zod";
import { officialCodeApprovalResult } from "../../electron/official-ui/api/cloud-code-approval";
import {
  cloudCodeEventId,
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { codeCommandRequestPrefix, officialCodeApprovalEvent, officialCodeLegacyApprovalEvent } from "../../shared/official-code-approval";
import { officialCodePermission, officialCodePermissionName, officialCodeSessionTitle, officialCodeTaskId } from "../../shared/official-code-history";
import { officialContextUsage } from "../../shared/official-code-context";
import { interruptTargetSchema } from "../../shared/interrupt-target";
import {
  codeTurnCancelledBeforeDispatch,
  officialCodeEvent,
  officialCodeControlContentType,
  officialCodeRepositoryStartup,
  type OfficialCodeQueueInput,
  type officialCodeFollowupPath,
} from "../../shared/official-code-followup";
import {
  officialCodeFollowupMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import type { CallFrame, Dispatcher } from "./dispatcher";
import { webErrorCodes } from "../../shared/web-protocol";
import {
  finishOfficialAction,
  officialActionReceiptFile,
  readOfficialAction,
  reserveOfficialAction,
} from "./official-ui-receipts";
import {
  queuedCodeAttachment,
  queuedCodeModelChoice,
  readCodeQueue,
  syncQueuedCodeAttachments,
  writeCodeQueue,
  type StoredCodeInput,
} from "./official-code-queue";
import type { WebAppContext } from "./web-app-context";
import { readOfficialCodeWorkspaceDiff } from "./official-code-workspace-diff";
import { hostedCodeRewindControl, rewindOfficialCodeSession } from "./official-code-rewind";
import { officialCodeCommands, prepareOfficialCodeCommand } from "./official-code-commands";
import { readCodeAgent, stopWorkflowAgent } from "../../electron/ipc/workflow";
import { codeAgentOwner } from "../../electron/engine/code-agent-threads";
import { codeAgentOutput } from "../../electron/official-ui/native/code-tasks";
import {
  officialCodeWorkspaceDirectory,
  readOfficialCodeWorkspaceFiles,
  workspaceFileControl,
} from "./official-code-workspace-files";

type FollowupPath = NonNullable<ReturnType<typeof officialCodeFollowupPath>>;
const imageBlock = z
  .object({
    type: z.literal("image"),
    source: z
      .object({
        type: z.literal("base64"),
        media_type: z.enum([
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
        ]),
        data: z.string().min(4),
      })
      .strict(),
  })
  .strict();
const textBlock = z
  .object({ type: z.literal("text"), text: z.string() })
  .strict();
const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const hashOf = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const userEvent = z
  .object({
    type: z.literal("user"),
    uuid: z.string().uuid(),
    session_id: z.string().optional(),
    parent_tool_use_id: z.null().optional(),
    initiator: z.string().max(80).optional(),
    client_platform: z.string().max(80).optional(),
    priority: z.enum(["next", "later"]).optional(),
    skill_references: skillReferencesSchema.optional(),
    file_attachments: z
      .array(
        z
          .object({
            file_uuid: z.string().uuid(),
            file_name: z.string().min(1).max(500),
            mime_type: z.string().max(160).optional(),
            original_name: z.string().max(500).optional(),
            is_image: z.boolean(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    message: z
      .object({
        role: z.literal("user"),
        content: z.union([
          z.string(),
          z
            .array(z.union([textBlock, imageBlock]))
            .min(1)
            .max(128),
        ]),
      })
      .strict(),
  })
  .strict();
const renameControl = z.object({
  subtype: z.literal("rename_session"),
  title: officialCodeSessionTitle,
}).strict();
const workspaceDiffControl = z.object({ subtype: z.literal("get_workspace_diff") }).strict();
const usageControl = z.strictObject({
  subtype: z.literal("get_context_usage"),
  detail: z.enum(["summary", "full"]).optional(),
});
const taskOutputControl = z.strictObject({ subtype: z.literal("get_task_output"), task_id: officialCodeTaskId });
const stopTaskControl = z.strictObject({ subtype: z.literal("stop_task"), task_id: officialCodeTaskId });
const codeControlRequestId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const codeControl = z
  .object({
    session_id: z.string().optional(),
    events: z.tuple([
      z
        .object({
          payload: z
            .object({
              type: z.literal("control_request"),
              uuid: z.string().uuid().optional(),
              request_id: codeControlRequestId,
              request: z.union([
                renameControl,
                hostedCodeRewindControl,
                z.object({ subtype: z.literal("initialize") }).strict(),
                workspaceDiffControl,
                workspaceFileControl,
                usageControl,
                taskOutputControl,
                stopTaskControl,
                z
                  .object({
                    subtype: z.literal("cancel_async_message"),
                    message_uuid: z.string().uuid(),
                  })
                  .strict(),
                z
                  .object({
                    subtype: z.literal("interrupt"),
                    cancel_queued: z.literal(true).optional(),
                    queued_message_uuid: z.string().uuid().optional(),
                    turn_target: interruptTargetSchema.optional(),
                    starting_input_uuid: z.string().uuid().optional(),
                  })
                  .strict(),
              ]),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

const legacyControl = z.object({
  type: z.literal("control_request"),
  uuid: z.string().uuid().optional(),
  request_id: codeControlRequestId,
  request: z.union([renameControl, hostedCodeRewindControl, workspaceDiffControl, workspaceFileControl, usageControl, taskOutputControl, stopTaskControl]),
}).strict();
const preferenceEvent = z
  .object({
    type: z.literal("control_request"),
    uuid: z.string().uuid().optional(),
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    request: z.discriminatedUnion("subtype", [
      z.object({
        subtype: z.literal("set_permission_mode"),
        mode: officialCodePermission,
      }).strict(),
      z
        .object({
          subtype: z.literal("set_model"),
          model: z.string().trim().min(1).max(200),
        })
        .strict(),
      z
        .object({
          subtype: z.literal("apply_flag_settings"),
          settings: z
            .strictObject({
              effortLevel: codeEffortInput.nullable().optional(),
              ultracode: z.boolean().optional(),
              fastMode: z.boolean().optional(),
            })
            .refine(({ effortLevel, ultracode, fastMode }) =>
              effortLevel !== undefined || ultracode !== undefined || fastMode !== undefined),
        })
        .strict(),
    ]),
  })
  .strict();
type PreferenceEvent = z.infer<typeof preferenceEvent>;
function changesModelPreference(request: PreferenceEvent["request"]) {
  return request.subtype === "set_model" ||
    (request.subtype === "apply_flag_settings" &&
      (request.settings.effortLevel !== undefined || request.settings.ultracode !== undefined));
}

const preferenceOrUser = z.union([preferenceEvent, userEvent]);
const preferenceBatch = z
  .object({
    session_id: z.string().optional(),
    events: z.array(preferenceOrUser).min(1).max(5),
  })
  .strict();
const wrappedPreferenceBatch = preferenceBatch.extend({
  events: z
    .array(
      z
        .object({
          payload: preferenceOrUser,
          user_declared_urls: z.array(z.string()).max(50).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(5),
});

const legacySend = z.strictObject({ session_id: z.string().optional(), events: z.tuple([z.union([userEvent, legacyControl])]) });

const json = (status: number, body: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(body)),
});
const noEvent = (): OfficialUiReadResponse => ({
  status: 204,
  contentType: "application/json",
  body: new Uint8Array(),
});
const unknownOutcome = () =>
  json(409, {
    error:
      "The previous Code follow-up may have been delivered. Reopen the session before retrying.",
  });
const conflictingEvent = () =>
  json(409, {
    error: "This Code event ID already belongs to another message.",
  });
const cancelledEvent = () =>
  json(409, { error: "This queued Code message was cancelled." });
const unavailableQueuedInput = () =>
  json(409, { error: "The queued Code message is no longer available." });
const stopUnconfirmed = () =>
  json(409, { error: "The Code stop could not be confirmed." });
const stopTargetChanged = () =>
  json(409, {
    error: "The active Code turn changed. Refresh the session and try again.",
  });

export const nativeCodeQueueMethods = ["codeQueue", "queueCodeMessage", "cancelCodeMessage", "sendQueuedCodeMessage", "codeQueueAttachment"];
const nativeQueueSubmit = z.strictObject({
  eventId: z.string().uuid(), text: z.string().max(200_000),
  attachmentIds: z.array(z.string().uuid()).max(12), priority: z.enum(["next", "later"]),
  choice: queuedCodeModelChoice.optional(),
});
type QueuedModelChoice = z.infer<typeof nativeQueueSubmit>["choice"];

function parse(request: Record<string, unknown>, route: FollowupPath) {
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > officialCodeFollowupMaxBytes ||
    !/^application\/json(?:\s*;.*)?$/i.test(String(request.contentType ?? ""))
  )
    return;
  try {
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
    const belongsToSession = (id: string | undefined) =>
      id === undefined || id === "session_" + route.key || id === "cse_" + route.key;
    const approval = (route.wrapped ? officialCodeApprovalEvent : officialCodeLegacyApprovalEvent).safeParse(body);
    if (approval.success) {
      const [event] = approval.data.events;
      const reply = "payload" in event ? event.payload.response : event.response;
      if (!belongsToSession(approval.data.session_id) ||
          (!route.wrapped && !reply.request_id.startsWith(codeCommandRequestPrefix)))
        return;
      return { kind: "approval" as const, reply };
    }
    if (route.wrapped) {
      const control = codeControl.safeParse(body);
      if (control.success) {
        const selected = control.data.session_id;
        if (
          selected !== undefined &&
          selected !== "session_" + route.key &&
          selected !== "cse_" + route.key
        )
          return;
        const { request, request_id } = control.data.events[0].payload;
        return {
          kind: "control" as const,
          control: request,
          requestId: request_id,
        };
      }
    }
    const wrappedBatch = route.wrapped
      ? wrappedPreferenceBatch.safeParse(body)
      : undefined;
    const legacyBatch = route.wrapped
      ? undefined
      : preferenceBatch.safeParse(body);
    const events = wrappedBatch?.success
      ? wrappedBatch.data.events.map(({ payload }) => payload)
      : legacyBatch?.success
        ? legacyBatch.data.events
        : [];
    const preferences = events.filter(
      (event): event is PreferenceEvent => event.type === "control_request",
    );
    let event: z.infer<typeof userEvent>;
    if (preferences.length) {
      const last = events.at(-1);
      const preferenceKinds = preferences.map(({ request }) =>
        request.subtype === "apply_flag_settings" && !changesModelPreference(request)
          ? "fast_mode"
          : request.subtype,
      );
      const flagsIndex = preferenceKinds.indexOf("apply_flag_settings");
      if (
        !belongsToSession(wrappedBatch?.data?.session_id ?? legacyBatch?.data?.session_id) ||
        new Set(preferenceKinds).size !== preferences.length ||
        new Set(preferences.map((entry) => entry.request_id)).size !==
          preferences.length ||
        (flagsIndex !== -1 && preferenceKinds.indexOf("set_model") > flagsIndex) ||
        (last?.type === "user"
          ? events.length !== preferences.length + 1
          : events.length !== preferences.length)
      )
        return;
      if (last?.type !== "user")
        return { kind: "preference" as const, preferences };
      event = last;
    } else {
      if (route.wrapped) {
        const [single] = events;
        if (events.length !== 1 || single.type !== "user" ||
            !belongsToSession(wrappedBatch?.data?.session_id)) return;
        event = single;
      } else {
        const legacy = legacySend.parse(body);
        if (!belongsToSession(legacy.session_id)) return;
        const [single] = legacy.events;
        if (single.type === "control_request") return {
          kind: "control" as const, control: single.request, requestId: single.request_id,
        };
        event = single;
      }
    }
    if (!belongsToSession(event.session_id)) return;
    const content = event.message.content;
    const blocks =
      typeof content === "string"
        ? [{ type: "text" as const, text: content }]
        : content;
    const text = blocks
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    const skillReferences = parseSkillReferences(text, event.skill_references ?? []);
    const images = blocks.filter((block) => block.type === "image");
    const documentIds = (event.file_attachments ?? []).map((file) =>
      file.file_uuid.toLowerCase(),
    );
    if (
      text.length > 200_000 ||
      images.length + documentIds.length > 12 ||
      new Set(documentIds).size !== documentIds.length ||
      (!text.trim() && !images.length && !documentIds.length)
    )
      return;
    const files = images.map(({ source }, index) => {
      const data = Buffer.from(source.data, "base64");
      const header = data.subarray(0, 6).toString("ascii");
      const mime =
        header === "GIF87a" || header === "GIF89a"
          ? "image/gif"
          : imageType(data);
      if (source.media_type !== mime || data.toString("base64") !== source.data)
        throw Error("Invalid image");
      return { name: `image-${index + 1}.${extensions[mime]}`, data };
    });
    // Preserve the old receipt identity for text-only requests.
    const modelSettings = preferences.map(({ request }) => request).filter(changesModelPreference);
    const hash =
      files.length || documentIds.length || modelSettings.length || skillReferences.length
        ? hashOf(
            JSON.stringify([
              text,
              files.map((file) => [file.name, hashOf(file.data)]),
              ...(documentIds.length ? [documentIds] : []),
              ...(modelSettings.length ? [modelSettings] : []),
              ...(skillReferences.length ? [skillReferences] : []),
            ]),
          )
        : hashOf(text);
    const legacySettings = preferences.map(({ request }) => request);
    const legacyHash = skillReferences.length ? hash : files.length || documentIds.length || legacySettings.length || event.priority
      ? hashOf(JSON.stringify([
          text, files.map(file => [file.name, hashOf(file.data)]),
          ...(documentIds.length ? [documentIds] : []),
          ...(legacySettings.length ? [legacySettings] : []),
          ...(event.priority ? [event.priority] : []),
        ]))
      : hash;
    return {
      kind: "user" as const,
      legacyHash,
      eventId: event.uuid.toLowerCase(),
      text,
      skillReferences,
      files,
      documentIds,
      hash,
      priority: event.priority,
      preferences,
    };
  } catch {
    return;
  }
}

function ownedSession(ctx: WebAppContext, owner: string, key: string) {
  const sessions = ctx.store.conversations.filter(
    (conversation) =>
      isOwnedCloudCodeSession(conversation, owner) &&
      cloudCodeSessionKey(conversation, owner) === key,
  );
  return sessions.length === 1 ? sessions[0] : undefined;
}

type FollowupQueue = {
  ctx: WebAppContext;
  owner: string;
  conversation: Conversation;
  current: () => boolean;
  entries: Map<string, StoredCodeInput>;
  sending: Set<string>;
  starts: Map<string, CodeSendStart>;
  steers: Set<string>;
  interrupting: boolean;
  sendNow?: string;
  stopWatching?: () => void;
  send: (
    entry: StoredCodeInput,
    attachments: Attachment[],
  ) => Promise<OfficialUiReadResponse>;
};

const queues = new WeakMap<Conversation, FollowupQueue>();
export function officialCodeInputInProgress(conversation: Conversation) {
  const queue = queues.get(conversation);
  return !!queue && (queue.sending.size > 0 || queue.interrupting);
}

const running = (conversation: Conversation) =>
  conversation.turns.some((turn) => turn.status === "inProgress");
const isWaiting = (entry: StoredCodeInput) =>
  entry.state === "queued" || entry.state === "held";
const waiting = (queue: FollowupQueue) =>
  [...queue.entries.values()].filter(isWaiting);
const turnIdentity = (conversation: Conversation) => {
  const turn = conversation.turns.at(-1);
  return turn && { id: turn.id, createdAt: turn.createdAt };
};
const actionKey = (
  owner: string,
  conversation: Conversation,
  eventId: string,
) =>
  JSON.stringify([
    "cloud-code-followup",
    owner,
    conversation.id,
    conversation.createdAt,
    eventId,
  ]);
const acceptedInput = (
  owner: string,
  conversation: Conversation,
  eventId: string,
) =>
  json(200, {
    events: [
      {
        event_id: cloudCodeEventId(
          "session_" + cloudCodeSessionKey(conversation, owner),
          eventId,
        ),
      },
    ],
  });

function saveEntries(queue: FollowupQueue, entries: Iterable<StoredCodeInput>) {
  const next = new Map([...entries].map((entry) => [entry.eventId, entry]));
  writeCodeQueue(
    queue.ctx.store.root,
    queue.owner,
    queue.conversation,
    next.values(),
  );
  queue.entries = next;
}

function saveEntry(queue: FollowupQueue, entry: StoredCodeInput) {
  const next = new Map(queue.entries);
  next.set(entry.eventId, entry);
  saveEntries(queue, next.values());
}

function writeInputReceipt(
  queue: FollowupQueue,
  entry: StoredCodeInput,
  result: OfficialUiReadResponse,
) {
  const key = actionKey(queue.owner, queue.conversation, entry.eventId);
  finishOfficialAction(
    officialActionReceiptFile(queue.ctx.store.root, key),
    entry.hash,
    result,
  );
}

function finishEntry(
  queue: FollowupQueue,
  entry: StoredCodeInput,
  result: OfficialUiReadResponse,
) {
  writeInputReceipt(queue, entry, result);
  removeFinishedInputs(queue, [entry.eventId]);
  return result;
}

function removeFinishedInputs(queue: FollowupQueue, ids: string[]) {
  for (const id of ids) {
    queue.entries.delete(id);
    queue.steers.delete(id);
  }
  if (ids.length) {
    try {
      saveEntries(queue, queue.entries.values());
    } catch (error) {
      queue.ctx.log(
        `claudex-runner: could not remove a finished Code queue input: ${String(error)}`,
      );
    }
  }
}

function attachmentAvailable(ctx: WebAppContext, file: Attachment) {
  const root = fs.realpathSync(path.join(ctx.store.root, "attachments"));
  const expected = path.join(root, file.id, file.name);
  return (
    !attachmentRefusal(file.name, file.size, ctx.policy()) &&
    fs.realpathSync(file.path) === expected &&
    fs.statSync(expected).size === file.size
  );
}

function queuedAttachments(queue: FollowupQueue, entry: StoredCodeInput) {
  return entry.attachments.map((file) =>
    queuedCodeAttachment(queue.ctx.store.root, file),
  );
}

function checkedAttachments(queue: FollowupQueue, entry: StoredCodeInput) {
  try {
    const attachments = queuedAttachments(queue, entry);
    return attachments.every((file, index) => {
      const digest = entry.attachments[index].sha256;
      return attachmentAvailable(queue.ctx, file) &&
        (!digest || hashOf(fs.readFileSync(file.path)) === digest);
    })
      ? attachments
      : undefined;
  } catch {
    return undefined;
  }
}

function queueFor(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  owner: string,
  conversation: Conversation,
) {
  const found = queues.get(conversation);
  if (found?.current()) {
    removeFinishedInputs(
      found,
      [...found.entries.keys()].filter((id) =>
        ctx.store.hasConfirmedOfficialCodeEvent(conversation, id),
      ),
    );
    return found;
  }
  found?.stopWatching?.();
  const store = ctx.store;
  const identity = ctx.officialSessionIdentity();
  const current = () =>
    dispatcher.context(ctx.userId) === ctx &&
    !ctx.closedFlag &&
    !ctx.signedOut &&
    ctx.activeAccount?.id === owner &&
    ctx.store === store &&
    ctx.officialSessionIdentity() === identity &&
    store.conversations.includes(conversation) &&
    isOwnedCloudCodeSession(conversation, owner) &&
    !conversation.archived;
  const saved = readCodeQueue(store.root, owner, conversation);
  const cancelled = new Set(
    conversation.turns
      .filter(codeTurnCancelledBeforeDispatch)
      .map((turn) => turn.officialCodeEventId),
  );
  const pending = saved.flatMap((entry) => {
    if (
      cancelled.has(entry.eventId) ||
      store.hasConfirmedOfficialCodeEvent(conversation, entry.eventId) ||
      store.hasConfirmedOfficialCodeStartup(conversation, entry.eventId)
    )
      return [];
    const receipt = readOfficialAction(
      store.root,
      actionKey(owner, conversation, entry.eventId),
      entry.hash,
    );
    if (receipt?.kind === "done")
      return entry.state === "steering" && receipt.answer.status === 200
        ? [entry]
        : [];
    return receipt?.kind === "pending"
      ? [entry]
      : [{ ...entry, state: "dispatching" as const }];
  });
  const priorTurn = conversation.turns.at(-1);
  const unknown = pending.some(
    (entry) =>
      !isWaiting(entry) &&
      entry.after?.id === priorTurn?.id &&
      entry.after?.createdAt === priorTurn?.createdAt,
  );
  const recovered = pending.map((entry): StoredCodeInput =>
    entry.state === "queued" &&
    (unknown ||
      priorTurn?.status !== "completed" ||
      priorTurn.id !== entry.after?.id ||
      priorTurn.createdAt !== entry.after.createdAt ||
      !store.hasConfirmedCodeCompletion(conversation, priorTurn))
      ? { ...entry, state: "held" }
      : entry,
  );
  const queue: FollowupQueue = {
    ctx,
    owner,
    conversation,
    current,
    entries: new Map(recovered.map((entry) => [entry.eventId, entry])),
    sending: new Set(),
    starts: new Map(),
    steers: new Set(),
    interrupting: false,
    send: async (entry, attachments) => {
      if (!current()) return unknownOutcome();
      const start = new CodeSendStart();
      queue.starts.set(entry.eventId, start);
      for (const file of attachments)
        ctx.selectedAttachments.set(file.id, file);
      try {
        await dispatcher.run(
          {
            ...frame,
            method: "send",
            args: encodeWireValue([
              {
                conversationId: conversation.id,
                mode: "code",
                providerId: entry.choice?.providerId ?? conversation.providerId,
                model: entry.choice?.model ?? conversation.model,
                ...(entry.choice?.effort && { effort: entry.choice.effort }),
                text: entry.text,
                ...(entry.skillReferences?.length ? { skillReferences: entry.skillReferences } : {}),
                attachments: attachments.map(({ id }) => ({ id })),
              },
            ]) as unknown[],
          },
          {
            context: ctx,
            identity,
            codeFollowup: {
              conversation,
              eventId: entry.eventId,
              start,
              ...(attachments.length || entry.modelSettings || entry.choice || entry.skillReferences?.length ? { inputHash: entry.hash } : {}),
              ...(entry.sendText === undefined ? {} : { sendText: entry.sendText }),
            },
          },
        );
      } catch (error) {
        if (
          (!start.cancelledBeforeDispatch &&
            !(error instanceof CodeSendCancelled)) ||
          !current()
        )
          throw error;
        return queue.entries.has(entry.eventId)
          ? finishEntry(queue, entry, noEvent())
          : noEvent();
      } finally {
        queue.starts.delete(entry.eventId);
      }
      if (!current()) return unknownOutcome();
      const startup = officialCodeRepositoryStartup(conversation);
      if (startup?.officialCodeEventId === entry.eventId && startup.id.startsWith("pending-")) {
        if (codeTurnCancelledBeforeDispatch(startup))
          return finishEntry(queue, entry, noEvent());
        await store.confirmOfficialCodeStartup(conversation, entry.eventId, current);
      } else {
        await store.confirmOfficialCodeEvent(conversation, entry.eventId, current);
      }
      if (!current()) return unknownOutcome();
      return finishEntry(
        queue,
        entry,
        acceptedInput(owner, conversation, entry.eventId),
      );
    },
  };
  if (
    recovered.length !== saved.length ||
    recovered.some((entry, index) => entry !== saved[index])
  )
    saveEntries(queue, recovered);
  queues.set(conversation, queue);
  if (waiting(queue).length) {
    watchQueue(queue);
    queueMicrotask(() => drainQueue(queue));
  }
  return queue;
}

export function officialCodeQueueInputs(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  conversation: Conversation,
): OfficialCodeQueueInput[] | undefined {
  const owner = ctx.activeAccount?.id;
  if (
    !owner ||
    conversation.archived ||
    !isOwnedCloudCodeSession(conversation, owner)
  )
    return;
  const queue = queueFor(dispatcher, frame, ctx, owner, conversation);
  if (!queue.current()) return;
  const legacy: OfficialCodeQueueInput[] = (conversation.officialCodeQueuedTurns ?? []).flatMap((entry) =>
    entry.queueState === "cancelled" || !entry.officialCodeEventId ? [] : [{
      eventId: entry.officialCodeEventId, text: entry.prompt, priority: entry.officialCodeQueuePriority ?? "later",
      createdAt: entry.createdAt, attachments: entry.attachments,
      state: entry.queueState === "dispatching" ? "unknown" : "queued",
    }]);
  const startup = officialCodeRepositoryStartup(conversation);
  return [...legacy, ...[...queue.entries.values()].flatMap(
    (entry): OfficialCodeQueueInput[] => {
      const event = officialCodeEvent(conversation.turns, entry.eventId);
      if (
        event &&
        (event.kind === "steer" ||
          !event.turn.id.startsWith("pending-") ||
          (event.turn === startup && event.turn.status !== "inProgress") ||
          codeTurnCancelledBeforeDispatch(event.turn))
      )
        return [];
      const state =
        entry.state === "dispatching" || entry.state === "steering"
          ? queue.sending.has(entry.eventId) || queue.steers.has(entry.eventId)
            ? "sending"
            : "unknown"
          : entry.state;
      return [
        {
          eventId: entry.eventId,
          text: entry.text,
          priority: entry.priority,
          createdAt: entry.createdAt,
          attachments: queuedAttachments(queue, entry),
          ...(entry.choice && { choice: entry.choice }),
          ...(entry.skillReferences?.length ? { skillReferences: entry.skillReferences } : {}),
          state,
        },
      ];
    },
  )];
}

export function readOfficialCodeQueueAttachment(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  conversationId: string,
  attachmentId: string,
) {
  const conversation = ctx.store.conversation(conversationId);
  const owner = ctx.activeAccount?.id;
  if (
    !owner ||
    conversation.archived ||
    !isOwnedCloudCodeSession(conversation, owner)
  )
    return null;
  const queue = queueFor(dispatcher, frame, ctx, owner, conversation);
  if (!queue.current()) return null;
  const matches = [...queue.entries.values()].flatMap((entry) =>
    entry.attachments
      .filter((file) => file.id === attachmentId)
      .map((file) => queuedCodeAttachment(ctx.store.root, file)),
  );
  matches.push(...(conversation.officialCodeQueuedTurns ?? []).flatMap(entry =>
    entry.queueState === "cancelled" ? [] : entry.attachments.filter(file => file.id === attachmentId)));
  const found = readOwnedAttachment(ctx.store.root, matches);
  return found && { name: found.attachment.name, data: found.data };
}

export function officialCodeHeldInputs(conversation: Conversation) {
  const queue = queues.get(conversation);
  if (!queue?.current()) return undefined;
  const pending = waiting(queue);
  const sendsHeldAfterError = pending
    .filter((entry) => entry.state === "held")
    .map((entry) => entry.eventId);
  return sendsHeldAfterError.length
    ? {
        unreadInputUuids: pending.map((entry) => entry.eventId),
        sendsHeldAfterError,
      }
    : undefined;
}

function watchQueue(queue: FollowupQueue) {
  if (queue.stopWatching) return;
  const { ctx, conversation } = queue;
  const off = ctx.onEvent((event) => {
    if (
      event.type !== "conversation" ||
      event.conversation.id !== conversation.id
    )
      return;
    if (!queue.current()) return queue.stopWatching?.();
    drainQueue(queue);
  });
  const deactivate = ctx.onAccountDeactivating(() => queue.stopWatching?.());
  queue.stopWatching = () => {
    off();
    deactivate();
    queue.stopWatching = undefined;
  };
}

function holdWaiting(queue: FollowupQueue) {
  if (waiting(queue).some((entry) => entry.state === "queued"))
    saveEntries(
      queue,
      [...queue.entries.values()].map((entry) =>
        entry.state === "queued" ? { ...entry, state: "held" } : entry,
      ),
    );
}

export function holdOfficialCodeInputsOnRestore(
  ctx: WebAppContext, owner: string, conversation: Conversation,
) {
  const queue = queues.get(conversation);
  if (queue?.ctx === ctx && queue.owner === owner) {
    holdWaiting(queue);
    return;
  }
  const inputs = readCodeQueue(ctx.store.root, owner, conversation);
  if (inputs.some(input => input.state === "queued"))
    writeCodeQueue(ctx.store.root, owner, conversation, inputs.map(input =>
      input.state === "queued" ? { ...input, state: "held" } : input));
}

export function forgetOfficialCodeInputs(ctx: WebAppContext, owner: string, conversation: Conversation) {
  queues.get(conversation)?.stopWatching?.();
  queues.delete(conversation);
  writeCodeQueue(ctx.store.root, owner, conversation, []);
}

async function startDispatch(
  queue: FollowupQueue,
  entry: StoredCodeInput,
  send: () => Promise<OfficialUiReadResponse>,
) {
  queue.sending.add(entry.eventId);
  let result = unknownOutcome();
  try {
    result = await send();
  } catch (error) {
    if ((error instanceof CodeRunAdmissionError || error instanceof CapacityError) && queue.current()) {
      saveEntry(queue, { ...entry, state: "held" });
      queue.ctx.push({ type: "conversation", conversation: structuredClone(queue.conversation) });
      result = codeRunRefusal(error);
    } else {
      queue.ctx.log(
        `claudex-runner: Code input could not be confirmed: ${String(error)}`,
      );
    }
  } finally {
    queue.sending.delete(entry.eventId);
    if (queue.current()) {
      try {
        if (result.status !== 200) holdWaiting(queue);
      } catch (error) {
        queue.ctx.log(
          `claudex-runner: could not hold pending Code inputs: ${String(error)}`,
        );
      }
      drainQueue(queue);
    }
  }
  return result;
}

async function acceptRepositoryStartup(
  { ctx, conversation, owner }: FollowupQueue,
  eventId: string,
  current: () => boolean,
  dispatch: () => Promise<OfficialUiReadResponse>,
) {
  let accept: (response: OfficialUiReadResponse) => void;
  const accepted = new Promise<OfficialUiReadResponse>((resolve) => { accept = resolve; });
  const off = ctx.onEvent(event => {
    if (event.type !== "conversation" || event.conversation.id !== conversation.id || !current()) return;
    const startup = officialCodeRepositoryStartup(conversation);
    if (startup?.officialCodeEventId !== eventId || startup.status !== "inProgress") return;
    off();
    void ctx.store.confirmOfficialCodeStartup(conversation, eventId, current).then(() => {
      if (current()) accept(acceptedInput(owner, conversation, eventId));
    }, () => {});
  });
  try {
    return await Promise.race([dispatch(), accepted]);
  } finally {
    off();
  }
}

function codeRunRefusal(error: CodeRunAdmissionError | CapacityError) {
  return json(error.code === webErrorCodes.capacity ? 429 : 503, { error: error.message });
}

function drainQueue(queue: FollowupQueue) {
  if (queue.conversation.officialCodeQueuedTurns?.some(entry => entry.queueState !== "cancelled")) return;
  const pending = waiting(queue);
  if (!pending.length) {
    queue.stopWatching?.();
    return;
  }
  if (!queue.current() || queue.interrupting) return;
  const conversation = queue.conversation;
  if (codeSessionLifecyclePending(conversation)) return;
  const active = running(conversation);
  const lastTurn = conversation.turns.at(-1);
  try {
    if (active) {
      const after = turnIdentity(conversation);
      if (
        after &&
        pending.some(
          (entry) =>
            entry.state === "queued" &&
            (entry.after?.id !== after.id ||
              entry.after?.createdAt !== after.createdAt),
        )
      )
        saveEntries(
          queue,
          [...queue.entries.values()].map((entry) =>
            entry.state === "queued" ? { ...entry, after } : entry,
          ),
        );
      return;
    }
    if (queue.sending.size) return;
    const explicit = queue.sendNow
      ? queue.entries.get(queue.sendNow)
      : undefined;
    if (!explicit && lastTurn?.status !== "completed") {
      if (lastTurn?.status === "interrupted" || lastTurn?.status === "failed")
        holdWaiting(queue);
      return;
    }
    const ready = pending.filter((entry) => entry.state === "queued");
    const entry =
      explicit ?? ready.find((input) => input.priority === "next") ?? ready[0];
    if (!entry) return;
    queue.sendNow = undefined;
    const attachments = checkedAttachments(queue, entry);
    if (!attachments) {
      saveEntry(queue, { ...entry, state: "held" });
      queueMicrotask(() => drainQueue(queue));
      return;
    }
    saveEntry(queue, {
      ...entry,
      after: turnIdentity(conversation),
      state: "dispatching",
    });
    void startDispatch(queue, entry, () => queue.send(entry, attachments));
  } catch (error) {
    queue.ctx.log(
      `claudex-runner: could not update the Code queue: ${String(error)}`,
    );
  }
}

function controlReply(requestId: string, response: object) {
  return {
    ...json(200, { requestId, response }),
    contentType: officialCodeControlContentType,
  };
}

function controlError(requestId: string, error: string) {
  return {
    ...json(200, { requestId, error }),
    contentType: officialCodeControlContentType,
  };
}

function cancelQueued(queue: FollowupQueue, entry: StoredCodeInput) {
  finishEntry(queue, entry, cancelledEvent());
  for (const [index, file] of queuedAttachments(queue, entry).entries()) {
    try {
      if (file.kind === "image" && !entry.attachments[index].retainOnCancel) {
        queue.ctx.selectedAttachments.delete(file.id);
        fs.rmSync(path.dirname(file.path), { recursive: true, force: true });
      } else if (attachmentAvailable(queue.ctx, file)) {
        queue.ctx.selectedAttachments.set(file.id, file);
      }
    } catch {
      // The attachment retention pass can collect this cancelled draft.
    }
  }
}

export async function confirmOfficialCodeReceipt(
  ctx: WebAppContext,
  key: string,
  eventId: string,
  active: () => boolean,
): Promise<OfficialUiReadResponse> {
  const owner = ctx.activeAccount?.id,
    store = ctx.store,
    identity = ctx.officialSessionIdentity();
  if (!owner || !active())
    return json(404, { error: "The Code message has not been confirmed." });
  const conversation = ownedSession(ctx, owner, key);
  const event = conversation && officialCodeEvent(conversation.turns, eventId);
  const legacy = conversation?.officialCodeQueuedTurns?.find((entry) => entry.officialCodeEventId === eventId);
  const startup = conversation && officialCodeRepositoryStartup(conversation);
  const provisional = event?.kind === "turn" && event.turn.id.startsWith("pending-");
  if (
    !conversation ||
    (!event && !legacy) ||
    (provisional && (event.turn !== startup || codeTurnCancelledBeforeDispatch(event.turn)))
  )
    return json(404, { error: "The Code message has not been confirmed." });
  const current = () =>
    active() &&
    ctx.activeAccount?.id === owner &&
    ctx.store === store &&
    ctx.officialSessionIdentity() === identity &&
    store.conversations.includes(conversation) &&
    isOwnedCloudCodeSession(conversation, owner);
  try {
    if (legacy) await store.confirmOfficialCodeQueue(conversation, eventId, current);
    else if (provisional) await store.confirmOfficialCodeStartup(conversation, eventId, current);
    else await store.confirmOfficialCodeEvent(conversation, eventId, current);
    if (!current()) return unknownOutcome();
    return noEvent();
  } catch {
    return unknownOutcome();
  }
}

export async function submitOfficialCodeFollowup(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  route: FollowupPath,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
  queuedChoice?: QueuedModelChoice,
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
  if (
    request.body instanceof Uint8Array &&
    request.body.byteLength > officialCodeFollowupMaxBytes
  )
    return json(413, {
      error: "The Code follow-up exceeds the Web history size limit.",
    });
  const followup = parse(request, route);
  if (!followup)
    return json(400, {
      error:
        "Send one follow-up with text or supported attachments to this Cloud Code session.",
    });

  const store = ctx.store;
  const identity = ctx.officialSessionIdentity();
  const conversation = ownedSession(ctx, account.id, route.key);
  if (conversation && followup.kind === "control" && followup.control.subtype === "rename_session")
    return conversation.titleSetByUser && conversation.title === followup.control.title
      ? json(200, { events: [] })
      : json(409, { error: "The Code session title changed. Reopen the session." });
  if (!conversation || conversation.archived)
    return json(404, { error: "Code session not found." });
  const current = () =>
    activationCurrent() &&
    ctx.store === store &&
    ctx.officialSessionIdentity() === identity &&
    store.conversations.includes(conversation) &&
    isOwnedCloudCodeSession(conversation, account.id) &&
    !conversation.archived;

  if ((followup.kind === "preference" || followup.kind === "user") &&
    followup.preferences.some(({ request }) =>
      request.subtype === "apply_flag_settings" && request.settings.fastMode === true))
    return json(409, { error: "Fast mode is unavailable on this Code host." });

  const savePreferences = async (preferences: PreferenceEvent[]) => {
    const expected = {
      providerId: conversation.providerId,
      model: conversation.model,
      effort: conversation.effort ?? null,
      codeUltracode: conversation.codeUltracode ?? false,
    };
    const settings = preferences.map((entry) => entry.request);
    const permission = settings.find(setting => setting.subtype === "set_permission_mode");
    if (permission && (
      permission.mode !== (conversation.codePermissionMode ?? "manual")
    )) throw Error("The Code session permission changed.");
    const modelSetting = settings.find(
      (setting) => setting.subtype === "set_model",
    );
    const flagSetting = settings
      .filter((setting) => setting.subtype === "apply_flag_settings")
      .find(changesModelPreference);
    const { effortLevel, ultracode } = flagSetting?.settings ?? {};
    if (!modelSetting && effortLevel === undefined && ultracode === undefined)
      return { model: conversation.model, effort: conversation.effort ?? null };

    const choice: Parameters<typeof saveCodeModelPreference>[2] = {};
    if (modelSetting || effortLevel !== undefined) {
      const model = modelSetting?.model ?? expected.model;
      const catalog = (await dispatcher.run(
        { ...frame, method: "modelCatalog", args: [] },
        { context: ctx, identity },
      )) as ModelCatalog | null;
      if (!current()) throw Error("The Code session changed.");
      const matches = catalog?.items.filter((item) => item.id === model) ?? [];
      if (matches.length !== 1) throw Error("The Code model is unavailable.");
      const [item] = matches;
      const fallback = store.settings.codeEffort;
      if (modelSetting)
        Object.assign(choice, codeModelChoice(item, conversation.effort, fallback, { kind: "model" }));
      if (effortLevel !== undefined)
        Object.assign(choice, codeModelChoice(item, conversation.effort, fallback, { kind: "effort", value: effortLevel }));
    }
    if (ultracode !== undefined) choice.codeUltracode = ultracode;
    const patch = readCodeModelPreference(
      { model: { version: 1, expected, choice } },
      conversation,
    );
    try {
      return await saveCodeModelPreference(
        {
          get store() {
            return ctx.store;
          },
          get engine() {
            return ctx.engineFor(conversation.id);
          },
          get accountRetiring() {
            return !current();
          },
          accountGeneration: () => ctx.officialSessionIdentity(),
          push: (event) => ctx.push(event),
        },
        conversation,
        patch,
      );
    } catch (error) {
      if (error instanceof CodeUltracodeUnavailable) return error;
      throw error;
    }
  };

  if (followup.kind === "approval") {
    if (!current())
      return json(409, { error: "The Code approval is no longer available." });
    const command = respondOfficialCodeCommand(
      ctx,
      conversation.id,
      followup.reply,
    );
    if (command === "confirmed") return json(200, { events: [] });
    if (command === "invalid")
      return json(400, {
        error: "The response does not match the Code command.",
      });
    if (command === "unconfirmed")
      return json(409, {
        error: "The Code command response could not be confirmed.",
      });
    const engine = ctx.engineFor(conversation.id);
    const result = officialCodeApprovalResult(
      conversation,
      engine.ownApprovals,
      followup.reply,
      store.settings.mcpServers,
    );
    if (result.kind === "stale")
      return json(409, { error: "The Code approval is no longer available." });
    if (result.kind === "invalid")
      return json(400, {
        error: "The response does not match the Code approval.",
      });
    try {
      engine.approve(result.id, result.response);
      return json(200, { events: [] });
    } catch {
      return json(409, { error: "The Code approval could not be confirmed." });
    }
  }

  if (followup.kind === "control") {
    if (!current())
      return json(409, { error: "The account activation changed." });
    const { control, requestId } = followup;
    if (control.subtype === "rewind_conversation") {
      const result = await rewindOfficialCodeSession(ctx, conversation, control,
        () => current() && !officialCodeInputInProgress(conversation));
      return current() ? controlReply(requestId, result) : unknownOutcome();
    }
    if (control.subtype === "get_task_output" || control.subtype === "stop_task") {
      const task = control.task_id;
      const taskCurrent = () => current() && !ctx.accountRetiring &&
        !conversation.linkedToComputer && !conversation.chatDeviceBinding &&
        (!conversation.sessionAuthors || conversation.sessionAuthors.viewerAccountUuid === account.id);
      if (!taskCurrent() || !codeAgentOwner(conversation, task))
        return json(404, { error: "Code task not found." });
      const engine = ctx.engineFor(conversation.id);
      const context = { store, engine, activeAccount: account, current: () => taskCurrent() && ctx.engineFor(conversation.id) === engine, push: (event: Parameters<WebAppContext["push"]>[0]) => ctx.push(event) };
      if (control.subtype === "stop_task") {
        const key = JSON.stringify(["cloud-code-stop-task", account.id, conversation.id, conversation.createdAt, requestId]);
        const hash = hashOf(task);
        try {
          const receipt = reserveOfficialAction(store.root, key, hash);
          if (receipt.kind === "done") return receipt.answer;
          if (receipt.kind !== "reserved") return stopUnconfirmed();
          await stopWorkflowAgent(context, conversation.id, task);
          if (!taskCurrent()) return stopUnconfirmed();
          const answer = json(200, { events: [] });
          finishOfficialAction(receipt.file, hash, answer);
          return answer;
        } catch {
          return stopUnconfirmed();
        }
      }
      try {
        const thread = await readCodeAgent(context, conversation.id, task);
        const output = codeAgentOutput(thread.turns).output;
        const limit = 64 * 1024;
        return taskCurrent()
          ? controlReply(requestId, { output: output.slice(-limit), truncated: output.length > limit })
          : unknownOutcome();
      } catch {
        return controlError(requestId, "The Code task output is unavailable.");
      }
    }
    if (
      control.subtype === "list_directory" ||
      control.subtype === "file_suggestions" ||
      control.subtype === "read_file"
    ) {
      const cwd = officialCodeWorkspaceDirectory(ctx, conversation);
      if (!cwd) return json(404, { error: "Code workspace not found." });
      try {
        const result = readOfficialCodeWorkspaceFiles(cwd, control);
        return result.error === undefined
          ? controlReply(requestId, result.response)
          : controlError(requestId, result.error);
      } catch (error) {
        const code =
          error instanceof Error && "code" in error ? error.code : undefined;
        const missing = code === "ENOENT" || code === "ENOTDIR";
        if (control.subtype === "list_directory")
          return controlError(
            requestId,
            missing ? "list denied: not_found" : "list denied: unexpected_error",
          );
        if (control.subtype === "read_file" && missing)
          return controlError(requestId, "ENOENT");
        return controlError(requestId, "The Code workspace files are unavailable.");
      }
    }
    if (control.subtype === "get_workspace_diff") {
      if (conversation.linkedToComputer || conversation.chatDeviceBinding ||
          (conversation.sessionAuthors && conversation.sessionAuthors.viewerAccountUuid !== account.id))
        return json(404, { error: "Code session not found." });
      const { cwd, environment } = conversation;
      const workspaceCurrent = () => current() && !ctx.accountRetiring &&
        conversation.cwd === cwd && conversation.environment === environment;
      const changed = () => json(409, { error: "The Code workspace changed." });
      if (!workspaceCurrent()) return changed();
      try {
        const diff = await readOfficialCodeWorkspaceDiff(ctx, conversation);
        if (!workspaceCurrent()) return changed();
        return controlReply(requestId, diff === undefined ? {} : { diff });
      } catch {
        return workspaceCurrent()
          ? json(503, { error: "The Code workspace diff is unavailable." })
          : changed();
      }
    }
    if (control.subtype === "cancel_async_message") {
      const id = control.message_uuid.toLowerCase();
      try {
        const legacy = conversation.officialCodeQueuedTurns?.find(entry => entry.officialCodeEventId === id);
        if (legacy) {
          const cancelled = await cancelLegacyCodeInput(ctx, conversation, legacy, current);
          return current() ? controlReply(requestId, { cancelled }) : unknownOutcome();
        }
        const queue = queueFor(
          dispatcher,
          frame,
          ctx,
          account.id,
          conversation,
        );
        const entry = queue.entries.get(id);
        if (!entry || !isWaiting(entry)) {
          const receipt = readOfficialAction(
            store.root,
            actionKey(account.id, conversation, id),
          );
          return controlReply(requestId, {
            cancelled:
              receipt?.kind === "done" && receipt.answer.status === 409,
          });
        }
        cancelQueued(queue, entry);
        if (queue.sendNow === id) queue.sendNow = undefined;
        drainQueue(queue);
        return controlReply(requestId, { cancelled: true });
      } catch {
        return unknownOutcome();
      }
    }
    if (control.subtype === "interrupt") {
      const queue = queueFor(dispatcher, frame, ctx, account.id, conversation);
      const target = control.queued_message_uuid?.toLowerCase();
      const selected = target ? queue.entries.get(target) : undefined;
      if (queue.interrupting) return stopUnconfirmed();
      if (
        target &&
        (control.cancel_queued || !selected || !isWaiting(selected))
      )
        return unavailableQueuedInput();
      if (selected && !checkedAttachments(queue, selected))
        return json(409, {
          error: "A Code attachment is unavailable. Select it again.",
        });
      const active = conversation.turns.filter(
        (turn) => turn.status === "inProgress",
      );
      const startingId = control.starting_input_uuid?.toLowerCase();
      const start = startingId && queue.starts.get(startingId);
      if (
        active.length > 1 ||
        (active.length === 1 && active[0] !== conversation.turns.at(-1)) ||
        (startingId &&
          (control.turn_target ||
            target ||
            control.cancel_queued ||
            !start ||
            (active[0] && (active[0].officialCodeEventId ?? active[0].compactionRequestId) !== startingId))) ||
        (!control.turn_target &&
          !start &&
          (active.length > 0 ||
            queue.sending.size > 0 ||
            (!target && !control.cancel_queued))) ||
        (control.turn_target &&
          !("kind" in control.turn_target) &&
          !control.turn_target.threadId)
      )
        return stopTargetChanged();
      const toCancel = control.cancel_queued ? waiting(queue) : [];
      const cancelled: string[] = [];
      queue.interrupting = true;
      try {
        if (start && startingId) {
          const result = await start.stop(current, () => holdWaiting(queue));
          if (result.status === "mismatch") return stopTargetChanged();
          if (!current()) return stopUnconfirmed();
          if (start.cancelledBeforeDispatch) {
            const pending = queue.entries.get(startingId);
            if (pending) finishEntry(queue, pending, noEvent());
            holdWaiting(queue);
            return json(200, { events: [], cancelled_start: startingId });
          }
        } else if (control.turn_target) {
          const result = await interruptExpectedTurn(
            {
              get store() {
                return ctx.store;
              },
              get engine() {
                return ctx.engineFor(conversation.id);
              },
              accountGeneration: () => (current() ? identity : undefined),
            },
            conversation.id,
            control.turn_target,
            target ? undefined : () => holdWaiting(queue),
          );
          if (result.status === "mismatch") return stopTargetChanged();
        }
        if (!current()) return stopUnconfirmed();
        if (target && !queue.entries.has(target))
          return unavailableQueuedInput();
        if (!target) holdWaiting(queue);
        queue.sendNow = target;
        for (const entry of toCancel) {
          const pending = queue.entries.get(entry.eventId);
          if (!pending || !isWaiting(pending)) continue;
          cancelQueued(queue, pending);
          cancelled.push(entry.eventId);
        }
        if (control.cancel_queued) {
          for (const entry of conversation.officialCodeQueuedTurns ?? []) {
            if (entry.queueState === "queued" && entry.officialCodeEventId &&
                await cancelLegacyCodeInput(ctx, conversation, entry, current))
              cancelled.push(entry.officialCodeEventId);
          }
        }
        return control.cancel_queued
          ? controlReply(requestId, {
              cancelled,
              still_queued: [
                ...waiting(queue).map((entry) => entry.eventId),
                ...(conversation.officialCodeQueuedTurns ?? []).flatMap(entry =>
                  entry.queueState !== "cancelled" && entry.officialCodeEventId ? [entry.officialCodeEventId] : []),
              ],
            })
          : json(200, { events: [] });
      } catch {
        queue.sendNow = undefined;
        if (queue.current()) {
          try {
            holdWaiting(queue);
          } catch (error) {
            ctx.log(
              `claudex-runner: could not hold pending Code inputs: ${String(error)}`,
            );
          }
        }
        return stopUnconfirmed();
      } finally {
        queue.interrupting = false;
        drainQueue(queue);
      }
    }
    const { model } = conversation;
    const permission = officialCodePermissionName(conversation.codePermissionMode ?? "manual");
    const response =
      control.subtype === "initialize"
        ? {
            commands: await officialCodeCommands(ctx, conversation) ?? [],
            agents: [],
            models: [{ value: model, displayName: model, description: "" }],
            current_permission_mode: permission,
          }
        : officialContextUsage(conversation) ?? {};
    return current() ? controlReply(requestId, response) : unknownOutcome();
  }

  if (followup.kind === "preference") {
    const { preferences } = followup;
    const key = JSON.stringify([
      "cloud-code-preference",
      account.id,
      conversation.id,
      conversation.createdAt,
      preferences.map((event) => event.request_id),
    ]);
    const hash = hashOf(
      JSON.stringify(preferences.map((event) => event.request)),
    );
    try {
      if (!current()) return unknownOutcome();
      const receipt = reserveOfficialAction(store.root, key, hash);
      if (receipt.kind === "done") return receipt.answer;
      if (receipt.kind !== "reserved") return unknownOutcome();
      const saved = await savePreferences(preferences);
      if (!current()) return unknownOutcome();
      const answer = saved instanceof CodeUltracodeUnavailable
        ? json(409, { error: saved.message })
        : preferences.length === 1
          ? {
              ...json(200, {
                requestId: preferences[0]!.request_id,
                response: { model: saved.model, effortLevel: saved.effort },
                persisted: true,
              }),
              contentType: officialCodeControlContentType,
            }
          : json(200, { events: [] });
      finishOfficialAction(receipt.file, hash, answer);
      return answer;
    } catch {
      return json(409, {
        error:
          "The Code model preference could not be confirmed. Reopen the session.",
      });
    }
  }

  const { eventId, text, skillReferences, files, documentIds, legacyHash, priority, preferences } = followup;
  const hash = queuedChoice ? hashOf(JSON.stringify([followup.hash, queuedChoice])) : followup.hash;
  const modelSettings = preferences.some(({ request }) => changesModelPreference(request));
  const recorded = officialCodeEvent(conversation.turns, eventId);
  const accepted = acceptedInput(account.id, conversation, eventId);
  const legacy = conversation.officialCodeQueuedTurns?.find(entry => entry.officialCodeEventId === eventId);
  if (legacy) {
    if (legacy.prompt !== text || legacy.officialCodeInputHash !== legacyHash) return conflictingEvent();
    try {
      await store.confirmOfficialCodeQueue(conversation, eventId, current);
      if (!current()) return unknownOutcome();
      if (legacy.queueState === "queued") wakeQueuedCode(dispatcher, frame, ctx, conversation, current);
      return accepted;
    } catch { return unknownOutcome(); }
  }

  const leadingSkill = skillReferences[0]?.start === text.length - text.trimStart().length;
  const compact = !leadingSkill && text.trim() === "/compact";
  const compactAttempt = [conversation.turns, ...(conversation.savedBranches ?? []).map(({ turns }) => turns)]
    .flat().find((turn) => turn.compactionRequestId === eventId);
  if (compactAttempt && (!compact || files.length || documentIds.length)) return conflictingEvent();
  if (compact && (recorded || files.length || documentIds.length || modelSettings || priority))
    return json(409, { error: "Compaction requires /compact without attachments." });
  if (!compact && !leadingSkill && /^\/compact\s/.test(text.trim()))
    return json(400, { error: "Use /compact without arguments to compact context." });
  if (compact) {
    if (compactAttempt?.compactionUncertain) return unknownOutcome();
    if (compactAttempt?.status === "failed") return json(409, { error: "The prior compaction did not complete." });
    if (compactAttempt?.status === "interrupted") return noEvent();
    const acceptedCompaction = acceptedInput(account.id, conversation, eventId + ":boundary");
    if (compactAttempt) {
      if (!isAcceptedCodeCompaction(compactAttempt)) return unknownOutcome();
      try {
        await store.confirmOfficialCodeCompaction(conversation, eventId, current);
        return current() ? acceptedCompaction : unknownOutcome();
      } catch { return unknownOutcome(); }
    }
    if (conversation.environment?.kind !== "space" || !officialCodeWorkspaceDirectory(ctx, conversation) ||
        (conversation.sessionAuthors && conversation.sessionAuthors.viewerAccountUuid !== account.id))
      return json(409, { error: "This Code session cannot compact context." });
    const existing = queues.get(conversation);
    if (existing?.starts.has(eventId)) return unknownOutcome();
    if (running(conversation) || existing?.sending.size || existing?.interrupting ||
        readCodeQueue(store.root, account.id, conversation).length)
      return json(409, { error: "Wait for the current turn and resolve queued input before compacting context." });
    const queue = queueFor(dispatcher, frame, ctx, account.id, conversation);
    const start = new CodeSendStart();
    queue.starts.set(eventId, start);
    queue.sending.add(eventId);
    let releaseEngine: (() => void) | undefined;
    try {
      if (!ctx.engineRunning()) releaseEngine = await dispatcher.engineSlot(ctx);
      if (!current()) return unknownOutcome();
      if (start.cancelledBeforeDispatch) return noEvent();
      await ctx.engineFor(conversation.id).compactConversation(conversation.id, current, eventId, start);
      await store.confirmOfficialCodeCompaction(conversation, eventId, current);
      return current() ? acceptedCompaction : unknownOutcome();
    } catch (error) {
      if (!current()) return unknownOutcome();
      if (start.cancelledBeforeDispatch) return noEvent();
      if (error instanceof CodeRunAdmissionError || error instanceof CapacityError) return codeRunRefusal(error);
      if (conversation.turns.some((turn) => turn.compactionRequestId === eventId && turn.compactionUncertain))
        return unknownOutcome();
      return json(409, { error: error instanceof Error ? error.message : "Could not start compacting." });
    } finally {
      releaseEngine?.();
      queue.starts.delete(eventId);
      queue.sending.delete(eventId);
      drainQueue(queue);
    }
  }
  // A saved turn is authoritative after a Runner migration or restart, even if
  // its old machine-local receipt is no longer available.
  if (recorded) {
    if (recorded.kind === "turn") {
      const { turn } = recorded;
      if (
        turn.prompt !== text ||
        ![hash, ...(turn.officialCodeQueueSequence !== undefined ? [legacyHash] : [])].includes(
          turn.officialCodeInputHash ?? (turn.attachments.length ? "" : hashOf(turn.prompt)),
        )
      )
        return conflictingEvent();
    } else if (
      recorded.steer.officialCodeInputHash !== hash
    ) {
      return conflictingEvent();
    }
    try {
      if (recorded.kind === "turn" && recorded.turn.id.startsWith("pending-")) {
        const { turn } = recorded;
        if (codeTurnCancelledBeforeDispatch(turn)) return noEvent();
        if (turn !== officialCodeRepositoryStartup(conversation)) return unknownOutcome();
        await store.confirmOfficialCodeStartup(conversation, eventId, current);
      } else {
        await store.confirmOfficialCodeEvent(conversation, eventId, current);
      }
      return current() ? accepted : unknownOutcome();
    } catch {
      return unknownOutcome();
    }
  }

  if (conversation.officialCodeQueuedTurns?.some(entry => entry.queueState !== "cancelled"))
    return json(409, { error: "A previously queued Code message is still being recovered." });
  const key = actionKey(account.id, conversation, eventId);
  try {
    assertCodeSessionSendAvailable(conversation);
  } catch {
    return json(409, { error: "The Code session is changing or its workspace is unavailable." });
  }
  let staged: Attachment[] = [];
  let retained = false;
  const discard = () => {
    for (const attachment of staged) {
      ctx.selectedAttachments.delete(attachment.id);
      try {
        fs.rmSync(path.join(store.root, "attachments", attachment.id), {
          recursive: true,
          force: true,
        });
      } catch {
        // The Runner's attachment retention pass can collect this draft.
      }
    }
  };
  try {
    if (!current()) return unknownOutcome();
    const queue = queueFor(dispatcher, frame, ctx, account.id, conversation);
    const pending = queue.entries.get(eventId);
    if (pending) {
      if (pending.hash !== hash) return conflictingEvent();
      if (isWaiting(pending)) return accepted;
    }
    const existing = readOfficialAction(store.root, key, hash);
    if (existing?.kind === "done") return existing.answer;
    if (existing?.kind === "conflict") return conflictingEvent();
    if (existing?.kind === "pending" || pending) return unknownOutcome();
    if (preferences.some(({ request }) => request.subtype === "set_permission_mode" &&
        request.mode !== (conversation.codePermissionMode ?? "manual")))
      return json(409, { error: "The Code session permission changed. Reopen the session." });
    const busy = () =>
      running(conversation) || queue.sending.size > 0 || queue.interrupting;
    if (((!priority && !skillReferences.length) || modelSettings) && busy())
      return json(409, { error: "Wait for the current Code turn to finish." });
    let sendText: string | undefined;
    try {
      sendText = await prepareOfficialCodeCommand(ctx, conversation, text, skillReferences);
    } catch {
      return json(409, { error: "The selected Code command is unavailable. Choose it again." });
    }
    if (!current()) return unknownOutcome();
    if (((!priority && !skillReferences.length) || modelSettings) && busy()) return json(409, { error: "Wait for the current Code turn to finish." });
    const documents: Attachment[] = [];
    try {
      for (const id of documentIds) {
        const file = ctx.selectedAttachments.get(id);
        if (
          !file ||
          file.id !== id ||
          !attachmentAvailable(ctx, file)
        )
          throw Error("Attachment unavailable");
        documents.push(file);
      }
    } catch {
      return json(400, {
        error: "A Code attachment is unavailable. Select it again.",
      });
    }
    if (files.length) {
      try {
        staged = storeOfficialAttachments(ctx, files);
      } catch {
        return json(400, {
          error:
            "The Runner could not stage the images under its attachment policy.",
        });
      }
    }
    const attachments = [...staged, ...documents];
    if (queuedChoice) {
      const provider = store.settings.providers.find(item => item.id === queuedChoice.providerId);
      const allowed = provider && (provider.model === queuedChoice.model || provider.models.includes(queuedChoice.model));
      const efforts = allowed ? ctx.engineFor(conversation.id).modelEfforts(queuedChoice.providerId, queuedChoice.model) : undefined;
      if (!allowed || (queuedChoice.effort && !efforts?.includes(queuedChoice.effort)))
        return json(400, { error: "The queued Code model or reasoning effort is unavailable." });
    }
    syncQueuedCodeAttachments(store.root, attachments);
    const receipt = reserveOfficialAction(store.root, key, hash);
    if (receipt.kind === "done")
      return current() ? receipt.answer : unknownOutcome();
    if (receipt.kind === "pending") return unknownOutcome();
    if (receipt.kind === "conflict") return conflictingEvent();

    const saved = modelSettings ? await savePreferences(preferences) : undefined;
    if (!current()) return unknownOutcome();
    if (saved instanceof CodeUltracodeUnavailable) {
      const answer = json(409, { error: saved.message });
      finishOfficialAction(receipt.file, hash, answer);
      return answer;
    }

    const steer =
      !queuedChoice && !skillReferences.length && priority === "next" && running(conversation) && !queue.interrupting;
    const defer = (!!priority || skillReferences.length > 0) && busy() && !steer;
    const entry: StoredCodeInput = {
      eventId,
      hash,
      text,
      ...(skillReferences.length && sendText === undefined ? { skillReferences } : {}),
      ...(modelSettings ? { modelSettings } : {}),
      ...(queuedChoice && { choice: queuedChoice }),
      ...(sendText === undefined ? {} : { sendText }),
      priority: priority ?? "next",
      createdAt: Date.now(),
      after:
        steer || !defer || running(conversation)
          ? turnIdentity(conversation)
          : undefined,
      state: steer ? "steering" : defer ? "queued" : "dispatching",
      attachments: attachments.map(({ id, name, size, kind, path }) => ({
        id,
        name,
        size,
        kind,
        sha256: hashOf(fs.readFileSync(path)),
        ...(kind === "image" && documentIds.includes(id) && { retainOnCancel: true as const }),
      })),
    };
    retained = true;
    saveEntry(queue, entry);
    if (defer) {
      ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
      watchQueue(queue);
      drainQueue(queue);
      return accepted;
    }
    const dispatch = () => startDispatch(queue, entry, async () => {
      if (!steer) return queue.send(entry, attachments);
      const acceptedSteer = await ctx
        .engineFor(conversation.id)
        .steerTurn(conversation.id, sendText ?? text, attachments, {
          eventId,
          inputHash: hash,
          current,
        });
      if (!current()) return unknownOutcome();
      if (acceptedSteer) {
        writeInputReceipt(queue, entry, accepted);
        queue.steers.add(entry.eventId);
        return accepted;
      }
      if (
        !running(conversation) &&
        queue.sending.size === 1 &&
        !queue.interrupting
      ) {
        saveEntry(queue, { ...entry, state: "dispatching" });
        return queue.send(entry, attachments);
      }
      saveEntry(queue, { ...entry, state: "queued" });
      ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
      watchQueue(queue);
      return accepted;
    });
    return await (!steer && !conversation.turns.length && conversation.pendingSetup?.length
      ? acceptRepositoryStartup(queue, eventId, current, dispatch)
      : dispatch());
  } catch {
    return unknownOutcome();
  } finally {
    if (!retained) discard();
  }
}

export async function nativeCodeQueue(dispatcher: Dispatcher, frame: CallFrame, ctx: WebAppContext, args: unknown[]) {
  const conversationId = z.string().min(1).max(500).parse(args[0]);
  const owner = ctx.activeAccount?.id;
  const identity = ctx.officialSessionIdentity();
  const conversation = ctx.store.conversation(conversationId);
  const current = () => dispatcher.context(ctx.userId) === ctx && !ctx.accountRetiring &&
    ctx.officialSessionIdentity() === identity && ctx.activeAccount?.id === owner;
  if (!owner || !current() || !isOwnedCloudCodeSession(conversation, owner) || conversation.archived)
    throw Error("Code session not found.");
  if (frame.method === "codeQueueAttachment") {
    const id = z.string().uuid().parse(args[1]);
    const file = readOfficialCodeQueueAttachment(dispatcher, frame, ctx, conversationId, id);
    if (!file) throw Error("The queued Code attachment is no longer available.");
    return file;
  }
  if (frame.method !== "codeQueue") {
    const key = cloudCodeSessionKey(conversation, owner);
    let payload: object;
    let choice: QueuedModelChoice;
    if (frame.method === "queueCodeMessage") {
      const input = nativeQueueSubmit.parse(args[1]);
      choice = input.choice;
      payload = {
        type: "user", uuid: input.eventId, priority: input.priority,
        message: { role: "user", content: input.text },
        file_attachments: input.attachmentIds.map(id => ({ file_uuid: id, file_name: id, is_image: false })),
      };
    } else {
      const eventId = z.string().uuid().parse(args[1]);
      const request = frame.method === "cancelCodeMessage"
        ? { subtype: "cancel_async_message", message_uuid: eventId }
        : { subtype: "interrupt", queued_message_uuid: eventId,
            turn_target: args[2] == null ? undefined : interruptTargetSchema.parse(args[2]) };
      payload = { type: "control_request", request_id: randomUUID(), request };
    }
    const result = await submitOfficialCodeFollowup(dispatcher, frame, ctx, { key, wrapped: true }, {
      contentType: "application/json", body: Buffer.from(JSON.stringify({ events: [{ payload }] })),
    }, current, choice);
    const reply = result.body.byteLength ? JSON.parse(Buffer.from(result.body).toString("utf8")) : {};
    if (result.status < 200 || result.status >= 300 || reply.error || reply.response?.cancelled === false)
      throw Object.assign(new Error(reply.error ?? "The queued Code message is no longer available."), {
        ...(result.status >= 500 && { code: webErrorCodes.runnerUnavailable }),
      });
    if (!current()) throw Error("The account activation changed.");
    if (frame.method !== "queueCodeMessage")
      ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
  }
  if (!current()) throw Error("The account activation changed.");
  const entries = officialCodeQueueInputs(dispatcher, frame, ctx, conversation);
  if (!entries) throw Error("The Code queue is unavailable.");
  return { entries: entries.map(entry => ({ ...entry, attachments: entry.attachments.map(file => ({ ...file, path: "" })) })) };
}

async function cancelLegacyCodeInput(
  ctx: WebAppContext,
  conversation: Conversation,
  entry: NonNullable<Conversation["officialCodeQueuedTurns"]>[number],
  current: () => boolean,
) {
  if (!current() || !entry.officialCodeEventId || entry.queueState === "dispatching") return false;
  entry.queueState = "cancelled";
  entry.attachments = [];
  await ctx.store.confirmOfficialCodeQueue(conversation, entry.officialCodeEventId, current);
  if (current()) ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
  return true;
}
export function resumeOfficialCodeQueues(dispatcher: Dispatcher, frame: CallFrame, ctx: WebAppContext,
  active: () => boolean) {
  const owner = ctx.activeAccount?.id, store = ctx.store, identity = ctx.officialSessionIdentity();
  if (!owner || !active()) return;
  for (const conversation of store.conversations) {
    if (!isOwnedCloudCodeSession(conversation, owner) || conversation.archived ||
        conversation.officialCodeQueuedTurns?.find(turn => turn.queueState !== "cancelled")?.queueState !== "queued") continue;
    const current = () => active() && ctx.store === store && ctx.activeAccount?.id === owner &&
      ctx.officialSessionIdentity() === identity && store.conversations.includes(conversation) &&
      isOwnedCloudCodeSession(conversation, owner) && !conversation.archived;
    wakeQueuedCode(dispatcher, frame, ctx, conversation, current);
  }
}

// A claimed message is never sent a second time after an uncertain dispatch.
const draining = new WeakSet<Conversation>();
const wakes = new WeakMap<Conversation, ReturnType<typeof setTimeout>>();
function wakeQueuedCode(dispatcher: Dispatcher, frame: CallFrame, ctx: WebAppContext,
  conversation: Conversation, current: () => boolean, delay = 250) {
  if (wakes.has(conversation) || draining.has(conversation) || !current()) return;
  const timer = setTimeout(() => {
    wakes.delete(conversation);
    void drainQueuedCode(dispatcher, frame, ctx, conversation, current);
  }, delay);
  timer.unref?.();
  wakes.set(conversation, timer);
}
async function drainQueuedCode(dispatcher: Dispatcher, frame: CallFrame, ctx: WebAppContext,
  conversation: Conversation, current: () => boolean) {
  if (draining.has(conversation) || !current()) return;
  const queued = conversation.officialCodeQueuedTurns?.find(turn => turn.queueState !== "cancelled");
  if (queued?.queueState !== "queued") return;
  if (conversation.turns.some(turn => turn.status === "inProgress") ||
      codeSessionLifecyclePending(conversation) || (queues.get(conversation)?.sending.size ?? 0) > 0) {
    wakeQueuedCode(dispatcher, frame, ctx, conversation, current);
    return;
  }
  draining.add(conversation);
  let completed = false;
  let retryAdmission = false;
  const store = ctx.store, identity = ctx.officialSessionIdentity();
  try {
    z.object({
      officialCodeEventId: z.string().uuid(), officialCodeInputHash: z.string().regex(/^[a-f0-9]{64}$/),
      prompt: z.string().max(200_000), modelText: z.string().max(200_000).optional(), attachments: z.array(z.object({
        id: z.string().uuid(), name: z.string().min(1).max(500).refine(name => path.basename(name) === name),
        path: z.string().max(4096), kind: z.enum(["image", "text", "document"]),
        size: z.number().int().nonnegative().max(30 * 1024 * 1024),
      })).min(1).max(12), officialCodeAttachmentHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(12), queueState: z.literal("queued"),
    }).passthrough().parse(queued);
    const root = fs.realpathSync(path.join(store.root, "attachments"));
    if (queued.officialCodeAttachmentHashes?.length !== queued.attachments.length) throw Error("Attachment unavailable");
    for (const [index, attachment] of queued.attachments.entries()) {
      if (attachmentRefusal(attachment.name, attachment.size, ctx.policy())) throw Error("Attachment unavailable");
      const expected = path.join(root, attachment.id, path.basename(attachment.name));
      if (fs.realpathSync(attachment.path) !== expected || fs.statSync(expected).size !== attachment.size ||
          hashOf(fs.readFileSync(expected)) !== queued.officialCodeAttachmentHashes[index])
        throw Error("Attachment unavailable");
    }
    if (!current()) return;
    queued.queueState = "dispatching";
    await store.confirmOfficialCodeQueue(conversation, queued.officialCodeEventId!, current);
    if (!current()) return;
    for (const attachment of queued.attachments) ctx.selectedAttachments.set(attachment.id, attachment);
    if (conversation.officialCodeQueuedTurns?.find(turn => turn.queueState !== "cancelled") !== queued) return;
    try {
      await dispatcher.run({ ...frame, method: "send", args: encodeWireValue([{
        conversationId: conversation.id, mode: "code", providerId: conversation.providerId,
        model: conversation.model, text: queued.prompt,
        attachments: queued.attachments.map(({ id }) => ({ id })),
      }]) as unknown[] }, { context: ctx, identity, codeFollowup: {
        conversation, eventId: queued.officialCodeEventId!, inputHash: queued.officialCodeInputHash,
        sendText: queued.modelText,
      } });
      const sent = conversation.turns.find(turn => turn.officialCodeEventId === queued.officialCodeEventId);
      if (!sent || !current()) throw Error("Dispatch outcome unknown");
      if (queued.officialCodeQueuePriority) sent.officialCodeQueuePriority = queued.officialCodeQueuePriority;
      sent.officialCodeQueueSequence = queued.officialCodeQueueSequence;
      await store.confirmOfficialCodeEvent(conversation, queued.officialCodeEventId!, current);
      const remaining = (conversation.officialCodeQueuedTurns ?? []).filter(turn => turn !== queued);
      if (remaining.length) conversation.officialCodeQueuedTurns = remaining;
      else delete conversation.officialCodeQueuedTurns;
      await store.confirmOfficialCodeQueue(conversation, queued.officialCodeEventId!, current);
      completed = true;
      const canonical = queues.get(conversation);
      if (canonical) drainQueue(canonical);
    } catch (error) {
      if ((error instanceof CodeRunAdmissionError || error instanceof CapacityError) && current()) {
        queued.queueState = "queued";
        await store.confirmOfficialCodeQueue(conversation, queued.officialCodeEventId!, current);
        retryAdmission = true;
        ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
        return;
      }
      ctx.log(`[official-ui] queued Code dispatch unconfirmed: ${error instanceof Error ? error.name : "unknown error"}`);
      // The durable dispatching marker remains; this outcome must never be replayed.
    }
  } catch (error) {
    ctx.log(`[official-ui] queued Code preparation unconfirmed: ${error instanceof Error ? error.name : "unknown error"}`);
    // Missing files or an uncertain claim must not result in an automatic resend.
  } finally {
    draining.delete(conversation);
    if (completed && conversation.officialCodeQueuedTurns?.find(turn => turn.queueState !== "cancelled")?.queueState === "queued")
      wakeQueuedCode(dispatcher, frame, ctx, conversation, current);
    else if (retryAdmission) wakeQueuedCode(dispatcher, frame, ctx, conversation, current, 2_000);
  }
}
