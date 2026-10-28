import type {
  ConversationRenderState,
  ConversationUpdate,
} from "../../shared/mobile/conversation-contract";

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 512;
const revision = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
export function validateState(
  value: unknown,
): asserts value is ConversationRenderState {
  if (
    !record(value) ||
    value.version !== 1 ||
    !id(value.sessionId) ||
    !revision(value.revision)
  )
    throw Error("Invalid render envelope");
  if (value.theme !== "light" && value.theme !== "dark")
    throw Error("Invalid theme");
  if (
    value.locale !== undefined &&
    (typeof value.locale !== "string" || value.locale.length > 64)
  )
    throw Error("Invalid locale");
  const c = value.conversation;
  if (
    !record(c) ||
    !id(c.id) ||
    !["chat", "code", "cowork"].includes(String(c.mode)) ||
    !Array.isArray(c.turns)
  )
    throw Error("Invalid conversation");
  const turnIds = new Set<string>();
  for (const t of c.turns) {
    if (
      !record(t) ||
      !id(t.id) ||
      turnIds.has(t.id) ||
      typeof t.prompt !== "string" ||
      !Array.isArray(t.items) ||
      !["inProgress", "completed", "interrupted", "failed"].includes(
        String(t.status),
      )
    )
      throw Error("Invalid turn");
    turnIds.add(t.id);
    const itemIds = new Set<string>();
    for (const i of t.items) {
      if (!record(i) || !id(i.id) || itemIds.has(i.id) || !id(i.type))
        throw Error("Invalid item");
      itemIds.add(i.id);
    }
  }
}
export function applyUpdate(
  state: ConversationRenderState,
  patch: ConversationUpdate,
): ConversationRenderState {
  if (
    !patch ||
    patch.version !== 1 ||
    patch.sessionId !== state.sessionId ||
    patch.baseRevision !== state.revision ||
    !revision(patch.revision) ||
    patch.revision <= state.revision ||
    !Array.isArray(patch.changes)
  )
    throw Error("Stale or invalid update; send a fresh render");
  let turns = [...state.conversation.turns];
  for (const change of patch.changes) {
    if (change.type === "upsertTurn") {
      const index = turns.findIndex((t) => t.id === change.turn.id);
      if (index < 0) turns.push(change.turn);
      else turns[index] = change.turn;
    } else if (change.type === "removeTurn") {
      turns = turns.filter((t) => t.id !== change.turnId);
    } else if (change.type === "appendItemText") {
      const turnIndex = turns.findIndex((t) => t.id === change.turnId);
      const turn = turns[turnIndex];
      const itemIndex =
        turn?.items.findIndex((i) => i.id === change.itemId) ?? -1;
      if (itemIndex < 0 || typeof change.text !== "string")
        throw Error("Unknown text target");
      const items = [...turn.items];
      items[itemIndex] = {
        ...items[itemIndex],
        text: (items[itemIndex].text ?? "") + change.text,
      };
      turns[turnIndex] = { ...turn, items };
    } else throw Error("Unsupported update operation");
  }
  const next: ConversationRenderState = {
    ...state,
    revision: patch.revision,
    conversation: { ...state.conversation, turns },
    ...(patch.locale === undefined ? {} : { locale: patch.locale }),
    ...(patch.theme === undefined ? {} : { theme: patch.theme }),
    ...(patch.sending === undefined ? {} : { sending: patch.sending }),
    ...(patch.replyFeedback === undefined
      ? {}
      : { replyFeedback: patch.replyFeedback }),
    media: patch.media === undefined ? state.media : patch.media,
  };
  validateState(next);
  return next;
}
