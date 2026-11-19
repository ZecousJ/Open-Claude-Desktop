import { randomUUID } from "node:crypto";
import { z } from "zod";
import { codeEffortInput } from "../../electron/ipc/code-model-preferences";
import {
  cloudCodeEventId,
  cloudCodeSession,
  cloudCodeSessionKey,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  officialCodeFollowupMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { isWebTabId } from "../../shared/web-protocol";
import type { Conversation, Turn } from "../../shared/types";
import type { CallFrame, Dispatcher } from "./dispatcher";
import { createOfficialCoworkSession } from "./official-cowork-creation";
import type { WebAppContext } from "./web-app-context";

const warm = z.strictObject({
  title: z.literal("__warming__"),
  model: z.string().min(1).max(200),
  memory_mode: z.enum(["enabled", "disabled"]).optional(),
  effort_level: codeEffortInput.optional(),
  surface: z.literal("hub"),
  timezone: z
    .string()
    .regex(/^[A-Za-z0-9_+\-/]{1,128}$/)
    .optional(),
  project_uuid: z.string().uuid().optional(),
});
const image = z.strictObject({
  type: z.literal("image"),
  source: z.strictObject({
    type: z.literal("base64"),
    media_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: z.string().min(4),
  }),
});
const event = z.strictObject({
  type: z.literal("user"),
  uuid: z.string().uuid(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.null().optional(),
  shouldQuery: z.literal(false).optional(),
  file_attachments: z
    .array(
      z.strictObject({
        file_uuid: z.string().uuid(),
        file_name: z.string().min(1).max(500),
        is_image: z.boolean(),
      }),
    )
    .max(12)
    .optional(),
  message: z.strictObject({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z
        .array(
          z.union([
            z.strictObject({ type: z.literal("text"), text: z.string() }),
            image,
          ]),
        )
        .min(1)
        .max(128),
    ]),
  }),
});
const control = z.strictObject({
  type: z.literal("control_request"),
  uuid: z.string().uuid().optional(),
  request_id: z.string().min(1).max(200),
  request: z.discriminatedUnion("subtype", [
    z.strictObject({
      subtype: z.literal("set_permission_mode"),
      mode: z.enum(["default", "auto", "bypassPermissions"]),
    }),
    z.strictObject({
      subtype: z.literal("set_max_thinking_tokens"),
      max_thinking_tokens: z.union([z.literal(0), z.literal(31999)]),
    }),
    z.strictObject({
      subtype: z.literal("apply_flag_settings"),
      settings: z.strictObject({ effortLevel: codeEffortInput }),
    }),
    z.strictObject({
      subtype: z.literal("initialize"),
      rendersChromeSetupOffer: z.literal(true),
    }),
    z.strictObject({
      subtype: z.literal("set_model"),
      model: z.string().min(1).max(200),
    }),
  ]),
});
const claim = z.strictObject({
  session_id: z.string().optional(),
  events: z
    .array(
      z.strictObject({
        payload: z.union([event, control]),
        user_declared_urls: z.array(z.string()).max(50).optional(),
      }),
    )
    .min(1)
    .max(8),
});
const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});
type Reservation = {
  id: string;
  owner: string;
  identity: unknown;
  capabilityLease: unknown;
  tab: string;
  webSession: string | undefined;
  store: WebAppContext["store"];
  input: z.infer<typeof warm>;
  createdAt: number;
  expires: number;
  busy: boolean;
  claimed?: { eventId: string; body: string; answer: OfficialUiReadResponse };
};
const reservations = new Map<string, Reservation>();
const prune = () => {
  for (const [key, row] of reservations)
    if (!row.busy && row.expires < Date.now()) reservations.delete(key);
};

function ownsReservation(frame: CallFrame, ctx: WebAppContext, row: Reservation) {
  return ctx.activeAccount?.id === row.owner &&
    ctx.store === row.store &&
    ctx.officialSessionIdentity() === row.identity &&
    frame.user.tabId === row.tab &&
    frame.user.webSession?.id === row.webSession;
}

export function reserveOfficialCoworkWarm(
  frame: CallFrame,
  ctx: WebAppContext,
  organization: string,
  request: Record<string, unknown>,
  current: () => boolean,
): OfficialUiReadResponse | undefined {
  if (!(request.body instanceof Uint8Array)) return;
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
  } catch {
    return;
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("title" in body) ||
    body.title !== "__warming__"
  )
    return;
  const parsed = warm.safeParse(body),
    owner = ctx.activeAccount?.id;
  if (!owner || !current())
    return json(409, { error: "The account activation changed." });
  if (organization !== organizationUuid(owner))
    return json(404, { error: "Organization not found." });
  if (
    !parsed.success ||
    request.body.byteLength > 16384 ||
    typeof request.contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(request.contentType)
  )
    return json(400, { error: "Unsupported Cowork warm options." });
  const { tabId, webSession } = frame.user;
  if (!isWebTabId(tabId))
    return json(401, { error: "A current web session is required." });
  prune();
  if (
    [...reservations.values()].filter((row) => row.owner === owner).length >=
      4 ||
    reservations.size >= 16
  )
    return json(503, { error: "Cowork warm capacity is unavailable." });
  const id = randomUUID(),
    key = cloudCodeSessionKey({ id }, owner);
  reservations.set(key, {
    id,
    owner,
    identity: ctx.officialSessionIdentity(),
    capabilityLease: request.capabilityLease,
    tab: tabId,
    webSession: webSession?.id,
    store: ctx.store,
    input: parsed.data,
    createdAt: Date.now(),
    expires: Date.now() + 5 * 60_000,
    busy: false,
  });
  return json(200, {
    session: {
      id: `session_${key}`,
      config: { model: parsed.data.model },
      tags: ["cowork-remote"],
    },
  });
}

export function readOfficialCoworkWarm(
  frame: CallFrame,
  ctx: WebAppContext,
  query: { kind: "session" | "events" | "stream"; key: string },
  organization: unknown,
  current: () => boolean,
): OfficialUiReadResponse | undefined {
  prune();
  const { key, kind } = query;
  const row = reservations.get(key);
  if (
    !row ||
    !current() ||
    !ownsReservation(frame, ctx, row) ||
    (organization !== undefined &&
      organization !== organizationUuid(row.owner)) ||
    ctx.store.conversations.some((conversation) => conversation.id === row.id)
  )
    return;
  const turn: Turn = {
    id: row.id,
    prompt: "",
    attachments: [],
    items: [],
    status: "inProgress",
    createdAt: row.createdAt,
  };
  const conversation: Conversation = {
    id: row.id,
    mode: "cowork",
    providerId: "",
    pinned: false,
    archived: false,
    title: "__warming__",
    model: row.input.model,
    effort: row.input.effort_level,
    ...(row.input.memory_mode === "disabled" ? { memoryDisabled: true } : {}),
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    turns: [turn],
  };
  const session = cloudCodeSession(conversation, row.owner);
  if (kind === "events") return json(200, { data: [], next_cursor: null });
  if (kind === "stream")
    return json(200, {
      conversation_id: row.id,
      cowork: true,
      processedQueue: [],
      session: { ...session, claudex_stop_target: null },
      data: [],
      has_more: false,
    });
  return json(200, { session });
}

export function discardOfficialCoworkWarm(
  frame: CallFrame,
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  current: () => boolean,
): OfficialUiReadResponse | undefined {
  prune();
  const row = reservations.get(key);
  if (!row || row.claimed ||
      ctx.store.conversations.some((conversation) => conversation.id === row.id))
    return;
  if (!current() || !ownsReservation(frame, ctx, row) ||
      request.capabilityLease !== row.capabilityLease || row.busy)
    return json(409, { error: "This Cowork warm start cannot be discarded." });
  if (request.codeOrganizationId !== undefined &&
      request.codeOrganizationId !== organizationUuid(row.owner))
    return json(404, { error: "Organization not found." });
  const { body, contentType } = request;
  if (body !== undefined && (!(body instanceof Uint8Array) ||
      (body.byteLength > 0 && (body.byteLength > 32 || typeof contentType !== "string" ||
        !/^application\/json(?:\s*;|$)/i.test(contentType) ||
        !/^\{\s*\}$/.test(Buffer.from(body).toString("utf8").trim())))))
    return json(400, { error: "Invalid Cowork warm discard." });
  reservations.delete(key);
  return json(200, {});
}

export async function claimOfficialCoworkWarm(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  current: () => boolean,
): Promise<OfficialUiReadResponse | undefined> {
  prune();
  const row = reservations.get(key);
  if (!row) return;
  const valid = () =>
    current() &&
    ownsReservation(frame, ctx, row) &&
    request.capabilityLease === row.capabilityLease;
  // Once persisted, other authorized tabs should use the normal session route.
  if (!valid()) return row.claimed ? undefined : json(409, { error: "The account activation changed." });
  if (
    request.codeOrganizationId !== undefined &&
    request.codeOrganizationId !== organizationUuid(row.owner)
  )
    return json(404, { error: "Organization not found." });
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > officialCodeFollowupMaxBytes ||
    typeof request.contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(request.contentType)
  )
    return json(400, { error: "Invalid Cowork message." });
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
  } catch {
    return json(400, { error: "Unsupported Cowork opening message." });
  }
  if (row.claimed) {
    const candidate = z
      .object({
        events: z.array(
          z
            .object({
              payload: z
                .object({ type: z.string(), uuid: z.string().optional() })
                .passthrough(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .safeParse(raw);
    const user = candidate.success
      ? [...candidate.data.events]
          .reverse()
          .find((entry) => entry.payload.type === "user")
      : undefined;
    if (user && user.payload.uuid?.toLowerCase() !== row.claimed.eventId)
      return;
  }
  let input: z.infer<typeof claim>;
  try {
    input = claim.parse(raw);
  } catch {
    return json(400, { error: "Unsupported Cowork opening message." });
  }
  const session = `session_${key}`;
  const payload = input.events.at(-1)!.payload;
  const preceding = input.events.slice(0, -1).map((entry) => entry.payload);
  if (
    payload.type !== "user" ||
    payload.shouldQuery !== undefined ||
    (input.session_id &&
      input.session_id !== session &&
      input.session_id !== `cse_${key}`) ||
    input.events.some(
      (entry) =>
        entry.payload.type === "user" &&
        entry.payload.session_id !== undefined &&
        entry.payload.session_id !== session &&
        entry.payload.session_id !== `cse_${key}`,
    )
  )
    return json(400, { error: "Invalid Cowork session or opening message." });
  const controls = preceding.filter(
    (entry): entry is z.infer<typeof control> =>
      entry.type === "control_request",
  );
  const reminders = preceding.filter(
    (entry): entry is z.infer<typeof event> => entry.type === "user",
  );
  if (
    new Set(controls.map((entry) => entry.request.subtype)).size !==
      controls.length ||
    new Set(controls.map((entry) => entry.request_id)).size !==
      controls.length ||
    reminders.some(
      (entry) =>
        entry.shouldQuery !== false ||
        entry.file_attachments ||
        typeof entry.message.content !== "string" ||
        !entry.message.content.startsWith("<system-reminder>") ||
        !entry.message.content.endsWith("</system-reminder>"),
    )
  )
    return json(400, { error: "Unsupported Cowork opening settings." });
  const system_reminders = reminders.map((entry) =>
    typeof entry.message.content === "string"
      ? entry.message.content.slice(17, -18)
      : "",
  );
  const settings = controls.map((entry) => entry.request);
  const permission = settings.find(
    (entry) => entry.subtype === "set_permission_mode",
  );
  const thinking = settings.find(
    (entry) => entry.subtype === "set_max_thinking_tokens",
  );
  const effort = settings.find(
    (entry) => entry.subtype === "apply_flag_settings",
  );
  const model = settings.find((entry) => entry.subtype === "set_model");
  const claimBody = Buffer.from(request.body).toString("base64");
  if (row.claimed)
    return row.claimed.body === claimBody
      ? row.claimed.answer
      : json(409, { error: "This Cowork opening was already claimed." });
  if (row.busy) return json(409, { error: "The Cowork start is in progress." });
  row.busy = true;
  try {
    const blocks =
      typeof payload.message.content === "string"
        ? [{ type: "text" as const, text: payload.message.content }]
        : payload.message.content;
    const message = blocks
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
    const images = blocks
      .filter((block): block is z.infer<typeof image> => block.type === "image")
      .map((block) => ({
        base64: block.source.data,
        media_type: block.source.media_type,
      }));
    const { title: _title, ...options } = row.input;
    const body = Buffer.from(
      JSON.stringify({
        ...options,
        message,
        message_uuid: payload.uuid,
        ...(payload.file_attachments
          ? { file_attachments: payload.file_attachments }
          : {}),
        ...(images.length ? { images } : {}),
        ...(system_reminders.length ? { system_reminders } : {}),
        ...(permission?.subtype === "set_permission_mode"
          ? { permission_mode: permission.mode }
          : {}),
        ...(thinking?.subtype === "set_max_thinking_tokens"
          ? { extended_thinking_enabled: thinking.max_thinking_tokens !== 0 }
          : {}),
        ...(effort?.subtype === "apply_flag_settings"
          ? { effort_level: effort.settings.effortLevel }
          : {}),
        ...(model?.subtype === "set_model" ? { model: model.model } : {}),
      }),
    );
    const result = await createOfficialCoworkSession(
      dispatcher,
      frame,
      ctx,
      organizationUuid(row.owner),
      { ...request, body },
      valid,
      { conversationId: row.id },
    );
    if (result.status !== 200) return result;
    const answer = json(200, {
      events: [
        { event_id: cloudCodeEventId(session, payload.uuid.toLowerCase()) },
      ],
    });
    row.claimed = {
      eventId: payload.uuid.toLowerCase(),
      body: claimBody,
      answer,
    };
    return answer;
  } finally {
    row.busy = false;
  }
}
