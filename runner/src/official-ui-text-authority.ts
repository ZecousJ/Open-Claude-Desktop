import {
  prepareCompletionAttachments,
  CompletionAttachmentError,
  validateAttachmentCapability,
  type CompletionAttachmentInput,
  type PreparedCompletionAttachment,
  type OwnedCompletionFile,
  type CompletionAttachmentCapability,
} from "../../electron/official-ui/api/completion-attachments";
/** Server-only strict text execution boundary. No production executor is installed here. */
import { createHash, randomUUID } from "node:crypto";
import type { Conversation } from "../../shared/types";
import { isOfficialTextReadiness } from "../../shared/official-ui-web";
import type {
  OfficialUiCapabilities,
  OfficialUiReadRequest,
  OfficialTextReadiness,
} from "../../shared/official-ui-web";

export interface StrictTextLease {
  accountId: string;
  /** A local check, not a serialized token or client-provided approval. */
  isCurrent(): boolean;
}
export interface StrictTextExecution extends StrictTextLease {
  /** Stable across activation/process retries; account+conversation+turn pair. */
  operationKey: string;
  payloadHash: string;
  send: Readonly<Record<string, unknown>>;
}
export interface StrictTextChatExecutor {
  /** Optional, explicit per-model input support. Absence must never enable attachment sends. */
  inspectAttachments?(
    lease: StrictTextLease & { model: string; providerId: string },
  ): Promise<CompletionAttachmentCapability>;
  /** Same atomic approval/budget/no-tools obligations as execute. The implementation
   * must resolve owned IDs against the captured account/selected object at final
   * byte-read, enforce byte/model limits and bind actual content to its receipt.
   * IDs/metadata are NOT path authority or proof of immutable bytes. Never grant
   * file tools; consume extracted text as explicitly derived model input only.
   * No production implementation is installed by this interface. */
  executeWithAttachments?(
    input: StrictTextExecution & {
      attachments: readonly PreparedCompletionAttachment[];
    },
  ): Promise<Conversation>;
  /** Actual host facts, not function-presence or a client declaration. No budget is reserved by this read. */
  inspect(lease: StrictTextLease): Promise<OfficialTextReadiness>;
  /** Must atomically bind the operation/hash to a task-wide authority, reserve a
   * conservative priced upper bound and enforce hard output limits + no tools.
   * Unknown delivery, timeout and cancellation MUST NOT release/replay a permit.
   * This is an execution boundary, not permission to call the legacy send. */
  execute(input: StrictTextExecution): Promise<Conversation>;
}
export interface StrictTextHost {
  accountId(): string | undefined;
  identity(): unknown;
  stateRoot(): string;
  isCurrent(): boolean;
  enabled(): boolean;
  actionsEnabled(): boolean;
  executor(): StrictTextChatExecutor | undefined;
  lookupOwnedAttachment?(id: string): OwnedCompletionFile | undefined;
  ownedAttachmentIdentity?(id: string): unknown;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
export function createStrictTextSession(host: StrictTextHost) {
  const owner = host.accountId(),
    identity = host.identity(),
    root = host.stateRoot(),
    lease = randomUUID();
  const openingExecutor = host.executor(),
    openingEnabled = host.enabled(),
    openingActions = host.actionsEnabled();
  const mode = openingEnabled ? "strict-text" : openingActions ? "engine-chat" : "read-only";
  const current = () =>
    !!owner &&
    identity !== undefined &&
    identity !== null &&
    identity !== "" &&
    host.isCurrent() &&
    host.accountId() === owner &&
    host.identity() === identity &&
    host.stateRoot() === root &&
    host.executor() === openingExecutor &&
    host.enabled() === openingEnabled &&
    host.actionsEnabled() === openingActions;
  const prepared = new WeakMap<
    PreparedCompletionAttachment[],
    {
      hash: string;
      capabilityHash: string;
      source: CompletionAttachmentInput;
      fileIdentities: Map<string, unknown>;
    }
  >();
  async function attachmentCapability(selection: {
    model: string;
    providerId: string;
  }) {
    const executor = host.executor();
    if (
      !current() ||
      !executor?.inspectAttachments ||
      !executor.executeWithAttachments ||
      (await inspect()).state !== "ready"
    )
      throw new CompletionAttachmentError(
        501,
        "attachments_unavailable",
        "Attachment sending is unavailable for this executor. Keep the files in your draft or remove them before sending.",
      );
    let result: CompletionAttachmentCapability;
    try {
      result = validateAttachmentCapability(
        await executor.inspectAttachments({
          accountId: owner!,
          isCurrent: current,
          model: selection.model,
          providerId: selection.providerId,
        }),
      );
    } catch (error) {
      if (!current()) throw Error("The account activation changed.");
      if (error instanceof CompletionAttachmentError) throw error;
      throw new CompletionAttachmentError(
        503,
        "attachment_capability_unavailable",
        "Attachment capabilities could not be checked. No attachment send was started.",
      );
    }
    if (!current()) throw Error("The account activation changed.");
    return result;
  }
  async function inspect(): Promise<OfficialTextReadiness> {
    if (!current()) return { state: "unavailable", reason: "session_changed" };
    if (!host.enabled() || !host.actionsEnabled())
      return { state: "unavailable", reason: "strict_mode_disabled" };
    const executor = host.executor();
    if (
      !executor ||
      typeof executor.inspect !== "function" ||
      typeof executor.execute !== "function"
    )
      return { state: "unavailable", reason: "executor_unavailable" };
    try {
      const result = await executor.inspect({
        accountId: owner!,
        isCurrent: current,
      });
      if (
        !current() ||
        host.executor() !== executor ||
        !host.enabled() ||
        !host.actionsEnabled()
      )
        return { state: "unavailable", reason: "session_changed" };
      if (!isOfficialTextReadiness(result))
        return { state: "error", reason: "source_error" };
      return { state: result.state, reason: result.reason };
    } catch {
      return { state: "error", reason: "source_error" };
    }
  }
  return {
    mode,
    lease,
    current,
    async prepareAttachments(input: CompletionAttachmentInput) {
      const capability = await attachmentCapability(input);
      const result = await prepareCompletionAttachments(input, {
        capability: async () => capability,
        lookupOwned: async (id) => host.lookupOwnedAttachment?.(id),
        isCurrent: current,
      });
      prepared.set(result, {
        hash: digest(canonical(result)),
        capabilityHash: digest(canonical(capability)),
        source: structuredClone(input),
        fileIdentities: new Map(
          input.files.map((id) => [id, host.ownedAttachmentIdentity?.(id)]),
        ),
      });
      return result;
    },
    accepts(value: unknown) {
      return current() && typeof value === "string" && value === lease;
    },
    async describe(): Promise<OfficialUiCapabilities> {
      const textChat: OfficialTextReadiness = mode === "engine-chat" && current()
        ? { state: "ready", reason: "ready" }
        : await inspect();
      return {
        version: 1,
        accountId: owner ?? "",
        activationLease: lease,
        mode,
        textChat,
      };
    },
    async execute(
      request: OfficialUiReadRequest,
      send: unknown,
      attachments?: PreparedCompletionAttachment[],
    ): Promise<Conversation> {
      const executor = host.executor();
      if (
        !executor ||
        (await inspect()).state !== "ready" ||
        !current() ||
        host.executor() !== executor
      )
        throw Error(
          "Strict text execution is unavailable for this account activation.",
        );
      const match = /\/chat_conversations\/([^/]+)\/completion$/.exec(
        request.path,
      );
      const input = JSON.parse(
        Buffer.from(request.body ?? []).toString("utf8"),
      );
      const human = input?.turn_message_uuids?.human_message_uuid,
        assistant = input?.turn_message_uuids?.assistant_message_uuid;
      if (
        !match ||
        !uuid.test(match[1]) ||
        typeof human !== "string" ||
        !uuid.test(human) ||
        typeof assistant !== "string" ||
        !uuid.test(assistant) ||
        human === assistant ||
        !send ||
        typeof send !== "object" ||
        Array.isArray(send)
      )
        throw Error("Invalid strict text operation.");
      const payload = structuredClone(send as Record<string, unknown>);
      if (Array.isArray(payload.skillReferences) && payload.skillReferences.length)
        throw Error("Selected skills are unavailable in strict text mode.");
      let attachmentsCurrent = () => true;
      if (attachments) {
        const proof = prepared.get(attachments);
        if (
          !proof ||
          proof.source.model !== payload.model ||
          proof.source.providerId !== payload.providerId ||
          proof.hash !== digest(canonical(attachments))
        )
          throw Error("Attachment preparation is unavailable or changed.");
        const inspectAttachmentMethod = executor.inspectAttachments,
          executeAttachmentMethod = executor.executeWithAttachments;
        attachmentsCurrent = () =>
          executor.inspectAttachments === inspectAttachmentMethod &&
          executor.executeWithAttachments === executeAttachmentMethod &&
          [...proof.fileIdentities].every(([id, identity]) => {
            if (
              identity === undefined ||
              host.ownedAttachmentIdentity?.(id) !== identity
            )
              return false;
            const expected = attachments.find(
              (item) => item.source === "owned-file" && item.id === id,
            );
            const actual = host.lookupOwnedAttachment?.(id);
            return (
              expected?.source === "owned-file" &&
              !!actual &&
              actual.id === expected.id &&
              actual.name === expected.name &&
              actual.size === expected.size &&
              actual.kind === expected.kind
            );
          });
        const capability = await attachmentCapability(proof.source);
        for (const [id, identity] of proof.fileIdentities)
          if (
            identity === undefined ||
            host.ownedAttachmentIdentity?.(id) !== identity
          )
            throw Error("An owned attachment was replaced before execution.");
        if (proof.capabilityHash !== digest(canonical(capability)))
          throw Error(
            "Attachment capabilities changed; reopen before sending.",
          );
        const again = await prepareCompletionAttachments(proof.source, {
          capability: async () => capability,
          lookupOwned: async (id) => host.lookupOwnedAttachment?.(id),
          isCurrent: current,
        });
        if (digest(canonical(again)) !== proof.hash)
          throw Error("An attachment changed before execution.");
        if (!attachmentsCurrent())
          throw Error("An owned attachment was replaced during preparation.");
      }
      const operationKey = digest([
        owner,
        match[1].toLowerCase(),
        human.toLowerCase(),
        assistant.toLowerCase(),
      ]);
      const payloadHash = digest(
        canonical(attachments ? { send: payload, attachments } : payload),
      );
      if (!current()) throw Error("The account activation changed.");
      // No fallback dispatcher/send is provided to this executor.
      const executionCurrent = () =>
        current() &&
        host.enabled() &&
        host.actionsEnabled() &&
        host.executor() === executor &&
        attachmentsCurrent();
      if (!executionCurrent())
        throw Error("Strict text execution was revoked.");
      const execution: StrictTextExecution = {
        accountId: owner!,
        isCurrent: executionCurrent,
        operationKey,
        payloadHash,
        send: Object.freeze(payload),
      };
      const result = attachments
        ? await executor.executeWithAttachments!({
            ...execution,
            attachments: structuredClone(attachments),
          })
        : await executor.execute(execution);
      if (!executionCurrent())
        throw Error(
          "The completion outcome is unknown after account retirement.",
        );
      return result;
    },
  };
}
