import { createHash } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  officialCodeHistoryRequest,
  officialCodePermissionName,
  officialCodeSequence,
  type OfficialCodeHistoryRequest,
  type OfficialCodeCommand,
  type OfficialCodeStreamSuggestion,
  type OfficialCodeStreamTool,
} from "../../../shared/official-code-history";
import { officialCodeTriggerId } from "../../../shared/official-code-triggers";
import type { RepositoryRef } from "../../../shared/host";
import { repositoryFullName } from "../../../shared/session-git";
import {
  officialCodeFollowupMaxBytes,
  officialUiReadMaxBytes,
  officialUiTransferMaxBytes,
} from "../../../shared/official-ui-web";
import { codeTurnCancelledBeforeDispatch, codeTurnStoppedByUser, officialCodeRepositoryStartup, type OfficialCodeQueueInput } from "../../../shared/official-code-followup";
import { officialContextUsage } from "../../../shared/official-code-context";
import { codeApiRetryMessage } from "../../../shared/official-code-retry";
import { officialCoworkDeviceId } from "./cowork-device-id";
import { preference } from "../../../shared/settings-extras";
import type { InterruptTarget } from "../../../shared/interrupt-target";
import type { Approval, Conversation, Item, Project, Settings, Turn } from "../../../shared/types";
import { visibleThinkingSummary } from "../../../shared/thinking-summaries";
import type { OfficialCodeApprovalControl } from "../../../shared/official-code-approval";
import { storedAttachmentImage } from "../native/code-attachments";
import {
  attachmentTranscript,
  codeFileWrites,
  codeSteerTranscriptInput,
  convertCodeTranscript,
  hydrateCodeOutput,
  type CodeTranscriptRow,
} from "../native/code-transcript";
import { codeToolTranscript } from "../native/code-tool-transcript";
import { codeAgentTranscript } from "../native/code-agent-transcript";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { learnAttachment } from "./files";
import { cloudCodeConnectorInventory, cloudCodeMcpConfig } from "./cloud-code-connectors";
import { knowledgeConnector } from "./knowledge-connector";
import { hiwonderKnowledgeEnabled } from "../../../shared/knowledge-api";
import { officialCodeApprovalControls } from "./cloud-code-approval";
import { isOwnedCloudCodeSession } from "./code-session-ownership";
import { codeOutputAttachment, flushGeneratedOutputBindings } from "./generated-output-files";

export { isOwnedCloudCodeSession } from "./code-session-ownership";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const cloudCodeSessionKey = (
  conversation: Pick<Conversation, "id">,
  owner: string,
) => digest(JSON.stringify([owner, conversation.id])).slice(0, 32);
const sessionId = (conversation: Conversation, owner: string) =>
  "session_" + cloudCodeSessionKey(conversation, owner);
export const cloudCodeEventId = (sessionId: string, messageId: string) =>
  "evt_" + digest(JSON.stringify([sessionId, messageId]));
const date = (time: number) => new Date(time).toISOString();
const streamPreviewMaxBytes = 128 * 1024;

export const isOwnedCloudCoworkSession = (conversation: Conversation, owner: string) =>
  conversation.mode === "cowork" && conversation.environment?.kind === "space" &&
  !conversation.incognito && !conversation.cloudHosted && !conversation.linkedToComputer &&
  (!conversation.chatDeviceBinding || (
    conversation.chatDeviceBinding.version === 1 &&
    conversation.chatDeviceBinding.organizationId === null &&
    conversation.sessionAuthors?.ownerAccountUuid === owner &&
    conversation.sessionAuthors.viewerAccountUuid === owner
  )) && (!conversation.sessionAuthors ||
    (conversation.sessionAuthors.ownerAccountUuid === owner && conversation.sessionAuthors.viewerAccountUuid === owner));

const lifecycle = (conversation: Conversation) =>
  conversation.archived ? "archived" : "active";
const sessionTags = (conversation: Conversation) =>
  [...(conversation.pinned ? ["ui:pinned"] : []), ...(conversation.mode === "cowork" ? ["cowork-remote"] : [])];
const sessionTriggerId = (conversation: Conversation) =>
  conversation.mode === "code" ? conversation.scheduledTaskId : undefined;

export function codeStopTarget(conversation: Conversation) {
  if (conversation.mode !== "code" || conversation.archived) return;
  const active = conversation.turns.filter((turn) => turn.status === "inProgress");
  const [turn] = active;
  if (active.length !== 1 || turn !== conversation.turns.at(-1)) return;
  const identity = {
    turnId: turn.id,
    turnCreatedAt: turn.createdAt,
    conversationCreatedAt: conversation.createdAt,
  };
  const starting = turn.id.startsWith("pending-");
  if (!starting && !conversation.threadId) return;
  const target: InterruptTarget = starting
    ? { kind: "starting", ...identity }
    : { ...identity, threadId: conversation.threadId };
  return {
    target,
    promptUuid: turn.officialCodeEventId ?? turn.compactionRequestId ?? (starting ? undefined : `${turn.id}:user`),
  };
}

export function cloudCodeSession(
  conversation: Conversation,
  owner: string,
  project?: Project,
  savingStop = false,
  codeUltracodeAvailable?: AdapterContext["codeUltracodeAvailable"],
) {
  const running =
    !conversation.archived &&
    (savingStop || conversation.turns.some((turn) => turn.status === "inProgress"));
  const triggerId = sessionTriggerId(conversation);
  const statusBucket = running ? "working"
    : conversation.turns.at(-1)?.status === "failed" ? "failed" : undefined;
  const repositories: readonly RepositoryRef[] = conversation.mode === "code"
    ? conversation.sessionRepositories?.length
      ? conversation.sessionRepositories
      : conversation.repository ? [conversation.repository] : []
    : [];
  const sources = repositories.flatMap((item, index) => {
    const repository = URL.parse(item.url);
    if (!repository || !["https:", "http:"].includes(repository.protocol)) return [];
    const branch = item.outcome ? undefined : index === 0 ? conversation.branch : item.branch;
    const revision = branch
      ? branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`
      : item.ref;
    return [{
      type: "git_repository",
      url: repository.origin + repository.pathname.replace(/\/+$/, ""),
      ...(revision ? { revision } : {}),
    }];
  });
  const outcomes = repositories.flatMap(({ url, outcome }) => {
    const repo = repositoryFullName(url);
    return repo && outcome ? [{
      type: "git_repository",
      git_info: { type: "github", repo, branches: [outcome.branch] },
    }] : [];
  });
  const checkedOut = conversation.mode === "code" && conversation.cwd &&
    conversation.repository && conversation.branch && !conversation.pendingSetup
      ? { [conversation.repository.fullName]: conversation.branch.replace(/^refs\/heads\//, "") }
      : undefined;
  const ultracode = conversation.mode === "code" &&
    codeUltracodeAvailable && conversation.codeUltracode !== undefined
    ? {
        is_ultracode_active: conversation.codeUltracode &&
          codeUltracodeAvailable(conversation.providerId, conversation.model, conversation.id),
      }
    : undefined;
  return {
    id: sessionId(conversation, owner),
    title: conversation.title,
    status: lifecycle(conversation),
    worker_status: running ? "running" : "idle",
    environment_kind: conversation.cloudEnvironmentId ? "anthropic_cloud" : "byoc",
    // Sessions without a saved profile still need an environment for the sidebar.
    environment_id:
      conversation.cloudEnvironmentId ??
      "env_" +
      digest(
        JSON.stringify([
          owner,
          conversation.environment?.kind === "space"
            ? conversation.environment.spaceId
            : conversation.id,
        ]),
      ).slice(0, 32),
    created_at: date(conversation.createdAt),
    last_event_at: date(conversation.updatedAt),
    started_by_account_id: owner,
    ...(conversation.mode === "cowork" && conversation.chatDeviceBinding
      ? { bound_device_uuid: officialCoworkDeviceId(owner, conversation.chatDeviceBinding.deviceId) }
      : {}),
    ...(conversation.mode === "cowork" && { claudex_knowledge_enabled: hiwonderKnowledgeEnabled(conversation) }),
    tags: sessionTags(conversation),
    unread: conversation.unread === true,
    ...(triggerId && { trigger_id: officialCodeTriggerId(triggerId), status_bucket: statusBucket }),
    ...(conversation.mode === "code" && { claudex_read_revision: conversation.readStateRevision ?? 0 }),
    ...(project ? { project: { uuid: project.id, name: project.name } } : {}),
    ...(checkedOut || ultracode ? {
      external_metadata: { ...(checkedOut && { current_branches: checkedOut }), ...ultracode },
    } : {}),
    config: {
      model: conversation.model,
      effort_level: conversation.effort,
      ...(conversation.mode === "cowork" && conversation.memoryDisabled
        ? { memory_mode: "MEMORY_MODE_DISABLED" }
        : {}),
      permission_mode: conversation.mode === "cowork"
        ? conversation.coworkPermissionMode === "bypass" ? "bypassPermissions" : conversation.chatDeviceBinding?.permission ?? conversation.coworkPermissionMode ?? "default"
        : officialCodePermissionName(conversation.codePermissionMode),
      ...(sources.length ? { sources } : {}),
      ...(outcomes.length ? { outcomes } : {}),
    },
  };
}

function cloudEvent(
  row: CodeTranscriptRow,
  eventId: string,
  index: number,
  selectedSessionId: string,
  owner: string,
  options: { code: boolean; dispatched: boolean; queued?: boolean; priority?: "later"; cancelled?: boolean },
) {
  const isUserInput =
    row.type === "user" &&
    !row.origin &&
    !row.parent_tool_use_id &&
    !options.cancelled && (options.dispatched || options.queued) &&
    !row.uuid.endsWith(":user-interrupt") &&
    (typeof row.message.content === "string" ||
      row.message.content.some(
        (block) => block.type === "text" || block.type === "image",
      ));
  return {
    event_id: eventId,
    sequence_num: index + 1,
    created_at: row.timestamp,
    source: isUserInput ? "client" : "worker",
    ...(isUserInput
      ? { sent_by_account_id: owner, ...(options.dispatched ? { processing_at: row.timestamp } : {}) }
      : {}),
    // The native projection includes internal source records. Only send the
    // original renderer's public transcript fields over the runner link.
    payload: options.cancelled ? {
      type: "control_response" as const, uuid: row.uuid,
      response: { subtype: "success" as const, request_id: `cancelled-${row.uuid}`, response: { cancelled: true } },
    } : {
      type: row.type,
      ...(options.priority ? { priority: options.priority } : {}),
      uuid: row.uuid,
      parentUuid: row.parentUuid,
      session_id: selectedSessionId,
      timestamp: row.timestamp,
      message: options.code && row.type === "assistant"
        ? { ...row.message, id: row.uuid }
        : row.message,
      ...(row.subtype ? { subtype: row.subtype } : {}),
      ...(row.parent_tool_use_id ? { parent_tool_use_id: row.parent_tool_use_id, isSidechain: true } : {}),
      ...(row.agentId ? { agentId: row.agentId } : {}),
      ...(row.subtype === "status"
        ? { status: row.status, compact_result: row.compact_result }
        : {}),
      ...(row.subtype === "compact_boundary" && row.compact_metadata
        ? { compact_metadata: row.compact_metadata }
        : {}),
      ...(row.subtype === "task_started" || row.subtype === "task_progress" || row.subtype === "task_notification"
        ? { task_id: row.task_id, tool_use_id: row.tool_use_id, ...("run_id" in row ? { run_id: row.run_id } : {}) }
        : {}),
      ...(row.subtype === "task_started"
        ? { task_type: row.task_type, description: row.description,
            ...("workflow_name" in row ? { workflow_name: row.workflow_name } : {}),
            ...("prompt" in row ? { prompt: row.prompt } : {}) }
        : {}),
      ...(row.subtype === "task_progress" && "workflow_progress" in row ? { workflow_progress: row.workflow_progress } : {}),
      ...("usage" in row && row.usage ? { usage: row.usage } : {}),
      ...(row.subtype === "task_notification"
        ? { status: row.status, summary: "run_id" in row ? row.summary : row.summary.slice(0, 1600) }
        : {}),
      ...(row.origin ? { origin: row.origin } : {}),
      ...(row.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
      ...(row.toolUseResult ? { tool_use_result: row.toolUseResult } : {}),
      ...(row.mcpMeta ? { mcpMeta: row.mcpMeta } : {}),
      ...(row.file_attachments
        ? { file_attachments: row.file_attachments }
        : {}),
    },
  };
}

const settledItem = (item: Item) =>
  ["completed", "failed", "interrupted", "declined"].includes(
    item.lifecycleStatus ?? item.status ?? "",
  );

const publishedTurn = (turn: Turn, startup: Turn | undefined) =>
  !turn.officialCodeEventId || !turn.id.startsWith("pending-") ||
  codeTurnCancelledBeforeDispatch(turn) ||
  (turn === startup && turn.status !== "inProgress");

/** A committed cursor must not point past rows that can still be inserted or replaced. */
function stableTranscript(conversation: Conversation) {
  const startup = officialCodeRepositoryStartup(conversation);
  const turns = conversation.turns.filter(turn => publishedTurn(turn, startup));
  const running = turns.findIndex((turn) => turn.status === "inProgress");
  if (running < 0) return { turns };
  const turn = turns[running];
  turns.length = running;
  // A provisional send can still fail before dispatch. Keep its optimistic
  // echo in the composer until the Runner has a real turn or a saved failure.
  if (turn.id.startsWith("pending-") || turn.shell) return { turns };
  const boundary = turn.items.findIndex((item) =>
    item.type !== "diff" && (item.type === "contextCompaction" || !settledItem(item)),
  );
  turns.push(
    boundary < 0 ? turn : { ...turn, items: turn.items.slice(0, boundary) },
  );
  const boundaryItem = turn.items[boundary];
  const item = boundaryItem?.type === "taskPlan"
    ? turn.items.slice(boundary + 1).reverse().find((candidate) =>
      candidate.type === "agentMessage" && candidate.text)
    : boundaryItem;
  const thinking = item?.type === "reasoning" ? visibleThinkingSummary(item).join("\n\n") : "";
  const partial = item && thinking
    ? { id: `${turn.id}:item:${item.id}`, text: thinking, kind: "thinking" as const }
    : item?.type === "agentMessage" && typeof item.text === "string" && item.text
      ? { id: `${turn.id}:item:${item.id}`, text: item.text }
      : undefined;
  return {
    turns,
    partial,
    unsettled: boundary < 0 ? undefined : { turn, boundary },
  };
}

const resultUuid = (turn: Turn) => `${turn.officialCodeEventId ?? turn.compactionRequestId ?? turn.id}:result`;

export function cloudCodeReadEvent(conversation: Conversation) {
  if (conversation.turns.some((turn) => turn.status === "inProgress")) return;
  const startup = officialCodeRepositoryStartup(conversation);
  for (let index = conversation.turns.length - 1; index >= 0; index--) {
    const turn = conversation.turns[index];
    if (!turn.compaction && publishedTurn(turn, startup)) return resultUuid(turn);
  }
}

function streamToolId(turn: Turn, item: Item) {
  if (item.type !== "mcpToolCall" && item.type !== "dynamicToolCall") return;
  const name = typeof item.tool === "string" && item.tool.trim();
  if (!name) return;
  if (
    item.type === "mcpToolCall" &&
    !name.startsWith("mcp__") &&
    !(typeof item.server === "string" && item.server.trim())
  ) return;
  return `${turn.id}:tool:${item.id}`;
}

function streamTools(
  { turn, boundary }: { turn: Turn; boundary: number },
  mcpServers: Settings["mcpServers"],
) {
  const tools: OfficialCodeStreamTool[] = [];
  let bytes = 0;
  for (const item of turn.items.slice(boundary)) {
    const id = streamToolId(turn, item);
    const inputs = id
      ? [{ id, ...codeToolTranscript(item, mcpServers) }]
      : codeFileWrites(turn.id, item);
    for (const { id, name, input } of inputs) {
      const tool = { id, name, inputJson: JSON.stringify(input) };
      bytes += Buffer.byteLength(JSON.stringify(tool)) + 1;
      if (bytes > streamPreviewMaxBytes) return tools;
      tools.push(tool);
    }
  }
  return tools;
}

function turnResult(
  turn: Turn,
  eventId: string,
  index: number,
  selectedSessionId: string,
  stopped: boolean,
  heldInputs?: ReturnType<NonNullable<AdapterContext["officialCodeHeldInputs"]>>,
) {
  const completed = turn.status === "completed";
  const isError = !completed && !stopped;
  return {
    event_id: eventId,
    sequence_num: index + 1,
    created_at: date(turn.createdAt),
    source: "worker",
    payload: {
      type: "result",
      uuid: resultUuid(turn),
      parent_tool_use_id: null,
      session_id: selectedSessionId,
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      ...heldInputs,
      ...(completed
        ? { stop_reason: "end_turn" }
        : turn.error
          ? { errors: [turn.error] }
          : {}),
    },
  };
}

type CodeEventContext = Parameters<typeof codeOutputAttachment>[0] &
  Pick<AdapterContext, "settings" | "officialCoworkApprovalControls" | "codeUltracodeAvailable">;

function selectedOutput(row: CodeTranscriptRow, conversation: Conversation, ctx: CodeEventContext) {
  if (conversation.mode !== "code" || !row.codeOutput) return row;
  const { turnId, itemId, fileId } = row.codeOutput;
  const turn = conversation.turns.find((entry) => entry.id === turnId);
  const item = turn?.items.find((entry) => entry.id === itemId);
  if (!turn || !item) return row;
  const file = item.generatedFiles?.find((entry) => entry.id === fileId);
  if (fileId && !file) return row;
  return hydrateCodeOutput(row, codeOutputAttachment(ctx, conversation, turn, item, file));
}

export function eventPage(
  conversation: Conversation,
  query: Extract<OfficialCodeHistoryRequest, { kind: "events" | "stream" }>,
  owner: string,
  ctx: CodeEventContext,
  project: Project | undefined,
  approvals?: readonly Approval[],
  heldInputs?: ReturnType<NonNullable<AdapterContext["officialCodeHeldInputs"]>>,
  queueInputs?: ReturnType<NonNullable<AdapterContext["officialCodeQueueInputs"]>>,
  commands?: OfficialCodeCommand[],
  commandControls?: readonly OfficialCodeApprovalControl[],
  remoteSession?: ReturnType<typeof cloudCodeSession>,
) {
  const { turns, partial, unsettled } = stableTranscript(conversation);
  const attachmentRoot = ctx.stateDirectory?.();
  const mcpServers = ctx.settings().mcpServers;
  const cwd = conversation.mode === "cowork" && conversation.cwd;
  const history = turns.map((turn) => {
    if (conversation.mode === "code") {
      const fallbacks = turn.items.filter((item) => item.gatewayFallback);
      return fallbacks.length
        ? { ...turn, items: [...turn.items.filter((item) => !item.gatewayFallback), ...fallbacks] }
        : turn;
    }
    if (!cwd) return turn;
    return { ...turn, items: turn.items.map((item) => {
      if (item.type !== "outputFiles" || !item.generatedFiles) return item;
      return { ...item, generatedFiles: item.generatedFiles.flatMap((file) => {
        const relative = path.relative(cwd, path.resolve(cwd, file.path));
        return relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)
          ? [{ ...file, path: "/mnt/user-data/working/" + relative }]
          : [];
      }) };
    }) };
  });
  for (const queued of conversation.officialCodeQueuedTurns ?? [])
    if (!history.some((turn) => turn.officialCodeEventId === queued.officialCodeEventId)) history.push(queued);
  const ends = new Map<number, Turn[]>();
  let latestResult: Turn | undefined;
  const { rows } = convertCodeTranscript(
    { ...conversation, turns: history },
    undefined,
    { mcpServers, onTurnEnd(turn, count) {
      if ((!turn.compaction || turn.compactionRequestId) && turn.status !== "inProgress") {
        const completed = ends.get(count) ?? [];
        completed.push(turn);
        ends.set(count, completed);
        if (!turn.compaction) latestResult = turn;
      }
    } },
  );
  const stream = query.kind === "stream";
  const selectedSessionId = remoteSession?.id ?? sessionId(conversation, owner);
  const queuedById = new Map((conversation.officialCodeQueuedTurns ?? []).map(turn => [turn.officialCodeEventId, turn]));
  const queue = queueInputs?.map(({ eventId, state }) => ({ uuid: eventId, state,
    ...(!queuedById.has(eventId) && { event_id: cloudCodeEventId(selectedSessionId, eventId) }),
  }));
  type Row =
    | { type: string; id: string; row: CodeTranscriptRow }
    | { type: "result"; id: string; turn: Turn };
  const transcript: Row[] = [];
  const taskUpdates: ReturnType<typeof cloudEvent>["payload"][] = [];
  for (const [index, row] of rows.entries()) {
    const id = cloudCodeEventId(selectedSessionId, row.uuid);
    if ((row.subtype === "task_progress" || row.subtype === "task_notification") && !("run_id" in row)) {
      taskUpdates.push(cloudEvent(row, id, index, selectedSessionId, owner, { code: true, dispatched: false }).payload);
    } else if (!row.parent_tool_use_id) {
      transcript.push({ type: row.type, id, row });
    }
    for (const ended of ends.get(index + 1) ?? [])
      transcript.push({
        type: "result",
        id: cloudCodeEventId(
          selectedSessionId,
          resultUuid(ended),
        ),
        turn: ended,
      });
  }
  const positions = new Map<string, number>();
  for (const turn of [...conversation.turns, ...queuedById.values()])
    if (turn.officialCodeEventId && turn.officialCodeQueueSequence !== undefined)
      positions.set(turn.officialCodeEventId, turn.officialCodeQueueSequence);
  const positioned: { row: Row; sequence: number }[] = [];
  for (const [id, sequence] of [...positions].sort((a, b) => a[1] - b[1])) {
    const index = transcript.findIndex(entry => "row" in entry && entry.row.type === "user" && entry.row.uuid === id);
    if (index >= 0) positioned.push({ row: transcript.splice(index, 1)[0], sequence });
  }
  for (const { row, sequence } of positioned)
    transcript.splice(Math.min(sequence - 1, transcript.length), 0, row);
  const events = transcript
    .map((entry, index) => ({ ...entry, index }))
    .filter(({ type }) => stream || !query.excludeTypes.includes(type));
  if (!stream && query.descending) events.reverse();
  const numeric =
    !stream && query.cursor !== null
      ? officialCodeSequence(query.cursor)
      : undefined;
  let cursorIndex = -1;
  if (stream) {
    cursorIndex = query.from - 1;
    if (
      query.from > events.length ||
      (query.afterEventId && events[cursorIndex]?.id !== query.afterEventId)
    )
      return undefined;
  } else if (numeric !== undefined) {
    if (numeric > transcript.length) return undefined;
    // A sequence can name a row skipped by exclude_types.
    const next = events.findIndex(({ index }) =>
      query.descending ? index + 1 < numeric : index + 1 > numeric,
    );
    cursorIndex = (next < 0 ? events.length : next) - 1;
  } else if (query.cursor !== null) {
    cursorIndex = events.findIndex((event) => event.id === query.cursor);
    if (cursorIndex < 0) return undefined;
  }
  // Cursor selection does not need attachment bytes. Only hydrate images
  // for the actual response page, not the rest of a long transcript.
  const attachmentsByEvent = new Map<string, {
    text: string;
    attachments: Turn["attachments"];
  }>();
  const undispatchedInputs = new Set<string>();
  for (const turn of [...queuedById.values(), ...conversation.turns]) {
    const inputUuid = turn.officialCodeEventId ?? `${turn.id}:user`;
    if ((turn.officialCodeEventId && turn.id.startsWith("pending-")) || codeTurnCancelledBeforeDispatch(turn))
      undispatchedInputs.add(inputUuid);
    if (turn.attachments.length)
      attachmentsByEvent.set(inputUuid, {
        text: turn.prompt, attachments: turn.attachments,
      });
    for (const item of turn.items) {
      const steer = codeSteerTranscriptInput(turn, item);
      if (steer?.attachments.length) attachmentsByEvent.set(steer.uuid, steer);
    }
  }
  const data: (
    ReturnType<typeof cloudEvent> | ReturnType<typeof turnResult>
  )[] = [];
  const session = stream
    ? remoteSession ?? cloudCodeSession(conversation, owner, project, false, ctx.codeUltracodeAvailable)
    : undefined;
  const retry = stream && conversation.mode === "code" && session?.worker_status === "running"
    ? codeApiRetryMessage(selectedSessionId, conversation.turns.at(-1))
    : undefined;
  const lastTurn = conversation.turns.at(-1);
  const suggestion: OfficialCodeStreamSuggestion | null = stream && conversation.mode === "code" &&
    !conversation.archived && session?.worker_status === "idle" &&
    lastTurn?.status === "completed" && latestResult?.id === lastTurn.id &&
    conversation.promptSuggestion?.turnId === lastTurn.id &&
    preference(ctx.settings(), "ccPromptSuggestions")
    ? { resultUuid: resultUuid(lastTurn), text: conversation.promptSuggestion.text }
    : null;
  const stopTarget = codeStopTarget(conversation);
  const compacting = conversation.turns.find((turn) => turn.compaction && turn.status === "inProgress");
  const controls = !stream ? [] : conversation.mode === "cowork"
    ? ctx.officialCoworkApprovalControls?.(conversation.id) ?? []
    : [
        ...officialCodeApprovalControls(
          conversation,
          commandControls === undefined ? approvals ?? [] : (approvals ?? []).filter(
            approval => approval.method !== "item/fileChange/requestApproval",
          ),
          mcpServers,
          !!remoteSession,
        ),
        ...(commandControls ?? []),
      ];
  const tools =
    stream && conversation.mode === "code" && unsettled
      ? streamTools(unsettled, mcpServers)
      : [];
  const recentTaskUpdates = taskUpdates.slice(-128);
  // The snapshot is private to the authenticated frame bridge. It keeps the
  // event subscription scoped to this exact Runner conversation.
  const state = stream
    ? {
        conversation_id: conversation.id,
        ...(conversation.mode === "cowork" && { cowork: true }),
        processedQueue: conversation.turns.flatMap((turn) => {
          const sequence = turn.officialCodeQueueSequence ?? queuedById.get(turn.officialCodeEventId)?.officialCodeQueueSequence;
          return turn.officialCodeEventId && sequence !== undefined && sequence <= query.from
            ? [{ event_id: cloudCodeEventId(selectedSessionId, turn.officialCodeEventId), timestamp: date(turn.createdAt) }]
            : [];
        }).slice(-256),

        session: { ...session, claudex_stop_target: stopTarget ?? null },
        ...(queue ? { queue } : {}),
        ...(controls.length ? { controls } : {}),
        ...(partial && Buffer.byteLength(partial.text) < streamPreviewMaxBytes
          ? { partial }
          : {}),
        ...(tools.length ? { tools } : {}),
        ...(commands ? { commands } : {}),
        ...(compacting ? { compacting: compacting.compactionRequestId ?? compacting.id } : {}),
        ...(conversation.mode === "code" ? { api_retry: retry ?? null, prompt_suggestion: suggestion } : {}),
        ...(recentTaskUpdates.length ? { task_updates: recentTaskUpdates } : {}),
      }
    : undefined;
  const historyExtras = {
    ...(commands ? { claudex_commands: commands } : {}),
    ...(!stream && !query.cursor && recentTaskUpdates.length ? { claudex_task_updates: recentTaskUpdates } : {}),
  };
  let bytes = 128 + Buffer.byteLength(JSON.stringify(state ?? historyExtras));
  for (const entry of events.slice(
    cursorIndex + 1,
    cursorIndex + 1 + (stream ? 100 : query.limit),
  )) {
    const { index, id } = entry;
    let event;
    let historyAttachments:
      Conversation["turns"][number]["attachments"] | undefined;
    if ("row" in entry) {
      const { row } = entry;
      const legacy = queuedById.get(row.uuid);
      const queued = !!legacy && !conversation.turns.some(turn => turn.officialCodeEventId === row.uuid);

      const input = row.type === "user" ? attachmentsByEvent.get(row.uuid) : undefined;
      let payload = row;
      if (input) {
        const images = input.attachments.filter(({ kind }) => kind === "image");
        const inputBytes = images.reduce(
          (total, { size }) => total + Math.ceil(size / 3) * 4,
          Buffer.byteLength(JSON.stringify(input.text)),
        );
        const remoteImages = inputBytes > officialCodeFollowupMaxBytes;
        const projected = attachmentTranscript(
          input.text,
          input.attachments,
          remoteImages ? undefined : (attachment) => storedAttachmentImage(attachmentRoot, attachment),
        );
        const files = projected.files.map((file) => ({
          ...file,
          is_image: remoteImages && images.some(({ id }) => id === file.file_uuid),
        }));
        historyAttachments = input.attachments.filter((attachment) => files.some((file) =>
          file.file_uuid === attachment.id && (attachment.kind !== "image" || file.is_image),
        ));
        payload = {
          ...row,
          message: { ...row.message, content: projected.content },
          file_attachments: files.length ? files : undefined,
        };
      } else if (!remoteSession) {
        payload = selectedOutput(row, conversation, ctx);
      }
      event = cloudEvent(
        payload, id, index, selectedSessionId, owner, {
          code: conversation.mode === "code",
          dispatched: !queued && !undispatchedInputs.has(row.uuid),
          ...(queued && legacy ? { queued: true, priority: legacy.officialCodeQueuePriority, cancelled: legacy.queueState === "cancelled" } : {}),
        },
      );
    } else {
      event = turnResult(entry.turn, id, index, selectedSessionId,
        conversation.mode === "code" && codeTurnStoppedByUser(entry.turn),
        entry.turn === latestResult ? heldInputs : undefined);
    }
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes > officialUiReadMaxBytes && data.length) break;
    if (bytes > officialUiTransferMaxBytes) return null;
    if (!remoteSession)
      for (const attachment of historyAttachments ?? [])
        learnAttachment(attachment, conversation.id);
    data.push(event);
    if (bytes > officialUiReadMaxBytes) break;
  }
  const hasMore = cursorIndex + 1 + data.length < events.length;
  const readEvent = conversation.mode === "code" ? cloudCodeReadEvent(conversation) : undefined;
  const readCursor = readEvent && data.some(({ payload }) => payload.uuid === readEvent)
    ? { claudex_read_event: { id: readEvent, revision: conversation.readStateRevision ?? 0 } }
    : {};
  if (stream) return { ...state, ...readCursor, data, has_more: hasMore };
  const through = query.descending
    ? data[0]?.sequence_num
    : hasMore
      ? data.at(-1)?.sequence_num
      : transcript.length;
  return {
    data,
    ...readCursor,
    ...(queue ? { queue } : {}),
    ...historyExtras,
    next_cursor: hasMore ? (data.at(-1)?.event_id ?? null) : null,
    ...(through ? { resume_cursor: String(through) } : {}),
  };
}

function agentEventsPage(
  conversation: Conversation,
  owner: string,
  request: Extract<OfficialCodeHistoryRequest, { kind: "teleport" }>,
  mcpServers: Settings["mcpServers"],
) {
  const selectedSessionId = sessionId(conversation, owner);
  const rows = conversation.turns.flatMap((turn) => turn.items.flatMap((item) =>
    item.agentThreads?.[request.agentId]
      ? codeAgentTranscript(conversation, turn, item, null, mcpServers).filter((row) => row.agentId === request.agentId)
      : []));
  const events = rows.map((row, index) => cloudEvent(row, cloudCodeEventId(selectedSessionId, row.uuid), index,
    selectedSessionId, owner, { code: true, dispatched: false }));
  const start = request.cursor ? events.findIndex(({ event_id }) => event_id === request.cursor) + 1 : 0;
  if (request.cursor && !start) return undefined;
  const data: typeof events = [];
  let bytes = 128;
  for (const event of events.slice(start, start + request.limit)) {
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes > officialUiReadMaxBytes && data.length) break;
    if (bytes > officialUiTransferMaxBytes) return null;
    data.push(event);
  }
  return { data, next_cursor: start + data.length < events.length ? data.at(-1)?.event_id ?? null : null };
}

export async function cloudCodeHistoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  ctx: AdapterContext,
) {
  const request = officialCodeHistoryRequest(
    req.method ?? "",
    pathname,
    url.search,
  );
  if (!request || (ctx.officialCodeHistory === undefined && ctx.officialCoworkHistory === undefined)) return false;
  const account = ctx.account();
  if (!account) return reply(res, { error: "Sign in to continue." }, 401);
  if ((!ctx.officialCodeHistory && !ctx.officialCoworkHistory) || ctx.isCurrent?.() === false)
    return reply(
      res,
      { error: "Cloud Code history is unavailable on this host." },
      403,
    );
  const org = req.headers["x-organization-uuid"];
  if (
    org !== undefined &&
    (typeof org !== "string" ||
      org.toLowerCase() !== organizationUuid(account.id))
  )
    return reply(res, { error: "Organization not found." }, 404);

  const ownsSession = (c: Conversation) => (ctx.officialCodeHistory && isOwnedCloudCodeSession(c, account.id)) ||
    (ctx.officialCoworkHistory && isOwnedCloudCoworkSession(c, account.id));
  const mode = request.kind === "list" && (request.tags.includes("cowork-remote") ? "cowork" : "code");
  if ((mode === "cowork" && !ctx.officialCoworkHistory) || (mode === "code" && !ctx.officialCodeHistory))
    return reply(res, { error: "Cloud session history is unavailable on this host." }, 403);
  const snapshot = await ctx.snapshot();
  const sessions = snapshot.conversations.filter(ownsSession);
  if (ctx.isCurrent?.() === false)
    return reply(res, { error: "The account changed." }, 409);
  const projects = new Map((snapshot.projects ?? [])
    .filter((project) => (project.kind ?? "chat") === "chat")
    .map((project) => [project.id, project]));
  const sessionProject = (c: Conversation) =>
    c.mode === "cowork" && c.projectId ? projects.get(c.projectId) : undefined;
  const stopPersistence = ctx.officialCodeStopPersistence;
  const savingStop = (c: Conversation) =>
    c.mode === "code" && stopPersistence &&
    c.turns.some(codeTurnStoppedByUser) && !stopPersistence.confirmed(c);
  const summary = (c: Conversation) => ({
    ...cloudCodeSession(c, account.id, sessionProject(c), savingStop(c), ctx.codeUltracodeAvailable),
    ...(c.mode === "code" && !c.archived && ctx.officialCodeWorkspaceDiffAvailable
      ? { connection_status: "connected" }
      : {}),
  });
  if (request.kind === "list") {
    const trigger = request.triggerSessions;
    const scheduled = trigger.kind !== "any";
    const filtered = sessions
      .filter(
        (c) =>
          c.mode === mode &&
          (!scheduled || (trigger.kind === "trigger"
            ? sessionTriggerId(c) === trigger.id
            : !!sessionTriggerId(c))) &&
          (!request.statuses.length ||
            request.statuses.includes(lifecycle(c))) &&
          request.tags.every((tag) => sessionTags(c).includes(tag)),
      )
      .sort((a, b) => (scheduled ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt) ||
        a.id.localeCompare(b.id));
    const cursorKey = request.cursor?.replace(/^(?:session|cse)_/, "");
    const cursorIndex = cursorKey
      ? filtered.findIndex(
          (c) => cloudCodeSessionKey(c, account.id) === cursorKey,
        )
      : -1;
    if (request.cursor !== null && cursorIndex < 0)
      return reply(
        res,
        { error: "Code session cursor is no longer available." },
        404,
      );
    const end = cursorIndex + 1 + request.limit;
    const data = filtered
      .slice(cursorIndex + 1, end)
      .map(summary);
    const pinned =
      request.includePinnedBeyondPage && !request.cursor
        ? filtered
            .slice(end)
            .filter((c) => c.pinned)
            .slice(0, 500)
            .map(summary)
        : [];
    const nextCursor = end < filtered.length ? (data.at(-1)?.id ?? null) : null;
    return reply(res, {
      data,
      next_cursor: nextCursor,
      ...(scheduled && { has_more: nextCursor !== null, last_id: nextCursor }),
      ...(pinned.length ? { pinned_beyond_page: { sessions: pinned } } : {}),
    });
  }

  const session = sessions.find(
    (c) => cloudCodeSessionKey(c, account.id) === request.key,
  );
  if (!session) return reply(res, { error: "Code session not found." }, 404);
  if (request.kind === "teleport") {
    const owned = session.mode === "code" && await ctx.officialCodeAgentHistory?.(session.id, request.agentId, !!request.cursor);
    if (ctx.isCurrent?.() === false) return reply(res, { error: "The account changed." }, 409);
    if (!owned) return reply(res, { error: "Code task not found." }, 404);
    const page = agentEventsPage(owned, account.id, request, ctx.settings().mcpServers);
    if (page === null) return reply(res, { error: "A Code task event exceeds the Web response limit." }, 413);
    return page ? reply(res, page) : reply(res, { error: "Code task cursor is no longer available." }, 404);
  }
  if (request.kind === "queue") {
    const input = session.mode === "code" && ctx.officialCodeQueueInputs?.(session.id)
      ?.find((entry) => entry.eventId === request.uuid);
    if (!input) return reply(res, { error: "Queued Code input not found." }, 404);
    return reply(res, queuedMessage(input, session, account.id, ctx.stateDirectory?.()));
  }
  if (request.kind === "session") {
    const metadata = summary(session);
    if (session.mode !== "code" || session.archived) return reply(res, { session: metadata });
    const knowledge = hiwonderKnowledgeEnabled(session) ? await knowledgeConnector(ctx) : undefined;
    if (ctx.isCurrent?.() === false) return reply(res, { error: "The account changed." }, 409);
    const inventory = cloudCodeConnectorInventory(ctx.settings().mcpServers, knowledge);
    const cwd = ctx.officialCodeWorkspaceDirectory?.(session);
    return reply(res, { session: {
      ...metadata,
      claudex_stop_target: codeStopTarget(session) ?? null,
      claudex_context_usage: officialContextUsage(session),
      session_context: {
        sources: metadata.config.sources,
        outcomes: metadata.config.outcomes,
        mcp_config: cloudCodeMcpConfig(session, inventory),
        effort_level: session.effort,
        ...(cwd && { cwd }),
      },
    } });
  }

  const conversation = await ctx.loadConversation(session.id);
  if (ctx.isCurrent?.() === false)
    return reply(res, { error: "The account changed." }, 409);
  if (
    !conversation ||
    !ownsSession(conversation) ||
    conversation.createdAt !== session.createdAt
  )
    return reply(res, { error: "Code session not found." }, 404);
  if (stopPersistence && savingStop(conversation)) {
    const confirmed = await stopPersistence.confirm(conversation).catch(() => false);
    if (ctx.isCurrent?.() === false)
      return reply(res, { error: "The account changed." }, 409);
    if (!confirmed)
      return reply(res, { error: "The stopped Code turn has not been saved." }, 503);
  }
  const commands = conversation.mode === "code" && (request.kind === "stream" || !request.cursor)
    ? await ctx.officialCodeCommands?.(conversation.id)
    : undefined;
  if (ctx.isCurrent?.() === false) return reply(res, { error: "The account changed." }, 409);
  const page = eventPage(
    conversation,
    request,
    account.id,
    ctx,
    sessionProject(conversation),
    request.kind === "stream" ? ctx.officialCodeApprovals?.() : undefined,
    conversation.mode === "code" ? ctx.officialCodeHeldInputs?.(conversation.id) : undefined,
    conversation.mode === "code" ? ctx.officialCodeQueueInputs?.(conversation.id) : undefined,
    commands,
    request.kind === "stream" ? ctx.officialCodeCommandControls?.(conversation.id) : undefined,
  );
  if (page === undefined)
    return reply(
      res,
      { error: "Code event cursor is no longer available." },
      request.kind === "stream" ||
        (request.cursor !== null &&
          officialCodeSequence(request.cursor) !== undefined)
        ? 410
        : 404,
    );
  if (page === null)
    return reply(
      res,
      { error: "A Code history event exceeds the Web response limit." },
      413,
    );
  flushGeneratedOutputBindings();
  return reply(res, page);
}

function queuedMessage(input: OfficialCodeQueueInput, conversation: Conversation, owner: string, root?: string) {
  const body = attachmentTranscript(input.text, input.attachments,
    (attachment) => storedAttachmentImage(root, attachment));
  for (const attachment of input.attachments)
    if (attachment.kind !== "image") learnAttachment(attachment, conversation.id);
  return {
    type: "user",
    uuid: input.eventId,
    session_id: sessionId(conversation, owner),
    parent_tool_use_id: null,
    timestamp: date(input.createdAt),
    priority: input.priority,
    message: { role: "user", content: body.content },
    ...(input.skillReferences?.length ? { claudexSkillSelection: { text: input.text, references: input.skillReferences } } : {}),
    ...(body.files.length ? { file_attachments: body.files } : {}),
    claudexQueueState: input.state,
  };
}
