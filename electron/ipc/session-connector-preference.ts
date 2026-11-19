import {
  mcpConnectionIdentity,
  mcpPolicyIdentity,
} from "../../shared/mcp-connection-identity";
import { z } from "zod";
import {
  connectorOverridesInput,
  connectorToolOverridesInput,
} from "../../shared/project-tools-input";
import {
  sessionConnectorPreferenceSnapshot,
  type SessionConnectorPreference,
} from "../../shared/session-connector-preference";
import type { Context } from "./conversations";
import type { Store } from "../store/store";
import type { Conversation } from "../../shared/types";
import { HIWONDER_KNOWLEDGE_SERVER, HIWONDER_KNOWLEDGE_TOOLS, HUANER_TECH, hiwonderKnowledgeEnabled } from "../../shared/knowledge-api";

const pending = new WeakMap<Store, Map<string, Promise<unknown>>>();
const preference = z
  .object({
    connectorOverrides: connectorOverridesInput,
    connectorToolOverrides: connectorToolOverridesInput,
  })
  .strict();
const guarded = z
  .object({
    connectorToolOverrides: z
      .object({
        version: z.literal(1),
        expected: z.string().max(8 * 1024 * 1024),
        policy: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        connection: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        identity: z
          .object({
            id: z.string().min(1).max(500),
            createdAt: z.number().finite().nullable(),
            mode: z.enum(["chat", "code", "cowork"]).nullable(),
          })
          .strict(),
        value: preference,
      })
      .strict(),
  })
  .strict();
export const isGuardedSessionConnectorPreference = (value: unknown) =>
  guarded.safeParse(value).success;

const legacy = preference
  .partial()
  .refine((value) => Object.keys(value).length > 0);

/** Guarded full snapshots use an existing field, so older hosts fail closed. */
export async function saveSessionConnectorPreference(
  context: Pick<
    Context,
    | "store"
    | "activeAccount"
    | "accountGeneration"
    | "accountActivationIdentity"
    | "accountRetiring"
    | "push"
    | "knowledgeCatalog"
  >,
  id: string,
  raw: unknown,
  scope?: { current(): boolean; configuration(): unknown; knowledgeCatalog?: NonNullable<Context["knowledgeCatalog"]> },
) {
  const store = context.store;
  const conversation = store.conversations.find((row) => row.id === id);
  if (!conversation) throw Error("Session not found.");
  const field = (raw as { connectorToolOverrides?: unknown })
    ?.connectorToolOverrides;
  const envelope =
    field &&
    typeof field === "object" &&
    typeof (field as { version?: unknown }).version === "number"
      ? guarded.parse(raw).connectorToolOverrides
      : undefined;
  if (
    envelope &&
    (envelope.identity.id !== conversation.id ||
      envelope.identity.createdAt !== (conversation.createdAt ?? null) ||
      envelope.identity.mode !== (conversation.mode ?? null))
  )
    throw Error("The session identity changed. Refresh before saving again.");
  const patch = envelope
    ? envelope.value
    : {
        connectorOverrides: structuredClone(
          conversation.connectorOverrides ?? {},
        ),
        connectorToolOverrides: structuredClone(
          conversation.connectorToolOverrides ?? {},
        ),
        ...legacy.parse(raw),
      };
  const next: SessionConnectorPreference = structuredClone(patch);
  const expected =
    envelope?.expected ?? sessionConnectorPreferenceSnapshot(conversation);
  const wanted = sessionConnectorPreferenceSnapshot(next);
  const accountIdentity = () =>
    context.accountGeneration?.() ?? context.accountActivationIdentity;
  const generation = accountIdentity(),
    account = context.activeAccount?.id;
  const createdAt = conversation.createdAt,
    mode = conversation.mode;
  const connection =
    envelope?.connection ?? mcpConnectionIdentity(store.settings.mcpServers);
  const selection = scope && JSON.stringify(scope.configuration());
  const identityCurrent = () =>
    (!scope ||
      (scope.current() && JSON.stringify(scope.configuration()) === selection)) &&
    !context.accountRetiring &&
    context.store === store &&
    accountIdentity() === generation &&
    context.activeAccount?.id === account &&
    conversation.id === id &&
    conversation.createdAt === createdAt &&
    conversation.mode === mode &&
    store.conversations.includes(conversation) &&
    store.conversations.filter((row) => row.id === id).length === 1 &&
    mcpConnectionIdentity(store.settings.mcpServers) === connection &&
    !conversation.turns.some((turn) => turn.status === "inProgress") &&
    !(conversation.incognito && conversation.threadId) &&
    (!conversation.sessionAuthors ||
      (!!account && conversation.sessionAuthors.ownerAccountUuid === account));
  const policyCurrent = () =>
    envelope?.policy === undefined ||
    envelope.policy === mcpPolicyIdentity(store.settings.mcpServers);
  const current = () => identityCurrent() && policyCurrent();
  if (generation == null)
    throw Error(
      "Account-scoped session connector updates are unavailable on this host.",
    );
  const changed = () => {
    throw Error(
      "The account, conversation or connector configuration changed. Refresh and try again.",
    );
  };
  if (!identityCurrent()) changed();
  let queue = pending.get(store);
  if (!queue) pending.set(store, (queue = new Map()));
  const operation = (queue.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!identityCurrent()) changed();
      // Respect the store's pending/uncertain-row boundary after earlier work drains.
      if (store.conversation(id) !== conversation) changed();
      if (sessionConnectorPreferenceSnapshot(conversation) !== expected)
        throw Error(
          "The session connector preferences changed. Refresh before saving again.",
        );
      if (!policyCurrent()) return structuredClone(conversation);
      const known = store.settings.mcpServers ?? {};
      const knowledgeTools = next.connectorToolOverrides[HIWONDER_KNOWLEDGE_SERVER] ?? {};
      const selected = (choice: Pick<Conversation, "connectorOverrides" | "connectorToolOverrides" | "knowledgeBases">, tool: string) =>
        hiwonderKnowledgeEnabled(choice) && choice.connectorToolOverrides?.[HIWONDER_KNOWLEDGE_SERVER]?.[tool] !== false;
      const after = { ...conversation, ...next };
      const revealsKnowledge = HIWONDER_KNOWLEDGE_TOOLS.some(tool => !selected(conversation, tool) && selected(after, tool));
      if (revealsKnowledge) {
        const legacy = JSON.stringify(conversation.knowledgeBases);
        const bases = await (scope?.knowledgeCatalog ?? context.knowledgeCatalog)?.();
        if (!current() ||
            sessionConnectorPreferenceSnapshot(conversation) !== expected ||
            JSON.stringify(conversation.knowledgeBases) !== legacy) changed();
        if (!bases?.some(base => base.id === HUANER_TECH && base.available))
          throw Error("The knowledge base is unavailable. Try again when it reconnects.");
      }
      // Retain old orphan choices so removing a connector does not block every
      // session edit. A renderer cannot add or alter a missing server's choices.
      for (const name of new Set([
        ...Object.keys(next.connectorOverrides),
        ...Object.keys(next.connectorToolOverrides),
        ...Object.keys(conversation.connectorOverrides ?? {}),
        ...Object.keys(conversation.connectorToolOverrides ?? {}),
      ])) {
        if (name === HIWONDER_KNOWLEDGE_SERVER) {
          const before = conversation.connectorToolOverrides?.[name] ?? {};
          if (Object.entries(knowledgeTools).some(([tool, choice]) =>
            !HIWONDER_KNOWLEDGE_TOOLS.some(knownTool => knownTool === tool) && before[tool] !== choice))
            throw Error("This knowledge-base tool does not exist.");
          continue;
        }
        if (Object.hasOwn(known, name)) continue;
        const before = sessionConnectorPreferenceSnapshot({
          connectorOverrides: Object.hasOwn(
            conversation.connectorOverrides ?? {},
            name,
          )
            ? { [name]: conversation.connectorOverrides![name] }
            : {},
          connectorToolOverrides: Object.hasOwn(
            conversation.connectorToolOverrides ?? {},
            name,
          )
            ? { [name]: conversation.connectorToolOverrides![name] }
            : {},
        });
        const after = sessionConnectorPreferenceSnapshot({
          connectorOverrides: Object.hasOwn(next.connectorOverrides, name)
            ? { [name]: next.connectorOverrides[name] }
            : {},
          connectorToolOverrides: Object.hasOwn(
            next.connectorToolOverrides,
            name,
          )
            ? { [name]: next.connectorToolOverrides[name] }
            : {},
        });
        if (before !== after) throw Error("This MCP server no longer exists.");
      }
      await store.persistSessionConnectorPreference(
        conversation,
        next,
        current,
      );
      if (
        !current() ||
        sessionConnectorPreferenceSnapshot(conversation) !== wanted
      )
        throw Error(
          "The session connector save could not be confirmed. Refresh before continuing.",
        );
      const saved = structuredClone(conversation);
      context.push?.({ type: "conversation", conversation: saved });
      return saved;
    });
  queue.set(id, operation);
  try {
    return await operation;
  } finally {
    if (queue.get(id) === operation) queue.delete(id);
  }
}
