import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Attachment, Conversation } from "../../shared/types";
import type {
  ChatDeviceBinding,
  ChatDeviceSendInput,
} from "../../shared/chat-devices-api";
import { portableChatDeviceConversation } from "../../shared/chat-device-context";
import { approvalPrefix } from "./chat-devices-support";
import type { ChatDeviceController } from "./chat-devices";
import type { Opened } from "./chat-devices";

export async function submit(
  this: ChatDeviceController,
  input: ChatDeviceSendInput,
  logicalId: string,
) {
  const known = this.host.conversations().find((c) => c.id === logicalId);
  let conversation = known
    ? this.target(logicalId)
    : ({
        ...input.options,
        id: logicalId,
        mode: input.mode,
        title: input.text.trim().slice(0, 100),
        providerId: input.providerId,
        model: input.model,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pinned: false,
        archived: false,
        turns: [],
      } as Conversation);
  if (conversation.mode !== input.mode)
    throw new Error("This conversation's execution mode changed. Try again.");
  let binding = this.binding(conversation, input.expectedBindingRevision);
  if (binding?.lastRequestId === input.requestId) return conversation;
  if (binding && binding.deviceId !== input.deviceId)
    throw new Error("Change this conversation's device before sending.");
  if (conversation.turns.some((turn) => turn.status === "inProgress"))
    throw new Error("This conversation is already responding.");
  await this.elected(input.deviceId, input.mode, input.taskPermission);
  const attachments = await this.transfers(input.attachments);
  if (!binding) {
    const source = portableChatDeviceConversation(conversation);
    const opened = (await this.call(
      { deviceId: input.deviceId },
      "chatDeviceImport",
      {
        source,
        taskPermission: input.taskPermission,
        providerId: input.providerId,
        model: input.model,
      },
    )) as Opened;
    if (
      !opened?.conversation?.id ||
      opened.conversation.deviceChatOrigin?.logicalConversationId !== logicalId
    )
      throw new Error("The computer couldn't confirm the Chat binding.");
    binding = {
      version: 1,
      accountScope: this.host.accountScope,
      organizationId: null,
      deviceId: input.deviceId,
      remoteConversationId: opened.conversation.id,
      revision: (conversation.chatDeviceRevision ?? 0) + 1,
      permission: input.taskPermission,
    };
    conversation = {
      ...conversation,
      chatDeviceBinding: binding,
      chatDeviceRevision: binding.revision,
    };
    try {
      await this.host.save(conversation);
      this.current();
    } catch (error) {
      await this.call(binding, "chatDeviceRelease", {
        remoteConversationId: binding.remoteConversationId,
      }).catch(() => {});
      throw error;
    }
  }
  let result: Opened;
  await this.call(binding, "chatDeviceActivate", {
    remoteConversationId: binding.remoteConversationId,
  });
  try {
    result = (await this.call(binding, "chatDeviceSend", {
      logicalConversationId: logicalId,
      remoteConversationId: binding.remoteConversationId,
      requestId: input.requestId,
      text: input.text,
      providerId: input.providerId,
      model: input.model,
      taskPermission: input.taskPermission,
      attachments,
      options: input.options,
    })) as Opened;
  } catch (error) {
    // A dropped response is not permission to resend. Confirm the bounded
    // device receipt before deciding whether the actual message started.
    const opened = (await this.call(binding, "chatDeviceOpen", {
      remoteConversationId: binding.remoteConversationId,
    }).catch(() => undefined)) as Opened | undefined;
    if (
      opened?.conversation.deviceChatOrigin?.lastRequestId !== input.requestId
    )
      throw error;
    result = opened;
  }
  return this.receive(
    conversation,
    { ...binding, permission: input.taskPermission },
    result,
    input.attachments
      .map((file) => this.host.attachment(file.id)!)
      .filter(Boolean),
  );
}

export async function receive(
  this: ChatDeviceController,
  previous: Conversation,
  binding: ChatDeviceBinding,
  opened: Opened,
  sentAttachments?: Attachment[],
) {
  this.current();
  const remote = opened?.conversation;
  if (
    !remote ||
    remote.id !== binding.remoteConversationId ||
    remote.mode !== previous.mode ||
    remote.deviceChatOrigin?.logicalConversationId !== previous.id ||
    remote.deviceChatOrigin.accountScope !== this.host.accountScope
  )
    throw new Error("The computer returned a different Chat binding.");
  // Runtime ids and local paths do not become executable cloud state.
  const spaceId = `device-chat-${createHash("sha256").update(previous.id).digest("hex").slice(0, 32)}`;
  const next: Conversation = {
    ...remote,
    id: previous.id,
    title: previous.title,
    pinned: previous.pinned,
    archived: previous.archived,
    projectId: previous.projectId,
    environment: { kind: "space", spaceId },
    cwd: path.join(this.host.root, "spaces", spaceId, "workspace"),
    chatDeviceBinding: {
      ...binding,
      lastRequestId: remote.deviceChatOrigin.lastRequestId,
    },
    chatDeviceRevision: binding.revision,
    importedHistory: true,
  };
  delete next.threadId;
  delete next.deviceChatOrigin;
  delete next.chatDeviceError;
  delete next.linkedToComputer;
  delete next.linkedComputerId;
  delete next.linkedComputerName;
  for (const [index, turn] of next.turns.entries()) {
    const prior = previous.turns.find((value) => value.id === turn.id);
    if (prior) turn.attachments = structuredClone(prior.attachments ?? []);
    else if (sentAttachments && index === next.turns.length - 1) {
      if (
        (turn.attachments?.length ?? 0) !== sentAttachments.length ||
        turn.attachments?.some(
          (file, i) => file.name !== sentAttachments[i].name,
        )
      )
        throw new Error("The computer returned different attachments.");
      turn.attachments = structuredClone(sentAttachments);
    } else if (turn.attachments?.length)
      throw new Error(
        "The conversation's attachments could not be transferred completely.",
      );
  }
  const digests = new Set<string>();
  JSON.stringify(next.turns, (key, value) => {
    if (
      key === "digest" &&
      typeof value === "string" &&
      /^[0-9a-f]{64}$/.test(value)
    )
      digests.add(value);
    return value;
  });
  const blobErrors = new Map<string, string>();
  for (const digest of digests) {
    try {
      const file = path.join(this.host.root, "generated-files", digest);
      try {
        await fs.access(file);
        continue;
      } catch {}
      const chunks: Buffer[] = [];
      let offset = 0,
        size = 0;
      do {
        const blob = (await this.call(binding, "chatDeviceBlob", {
          remoteConversationId: binding.remoteConversationId,
          digest,
          offset,
          length: 256 * 1024,
        })) as { data: string; size: number };
        if (
          !Number.isInteger(blob.size) ||
          blob.size < 0 ||
          blob.size > 16 * 1024 * 1024 ||
          (offset && blob.size !== size)
        )
          throw new Error("The transferred generated file was not valid.");
        size = blob.size;
        const chunk = Buffer.from(blob.data, "base64");
        if (
          chunk.length > 256 * 1024 ||
          offset + chunk.length > size ||
          (chunk.length === 0 && offset < size)
        )
          throw new Error("The transferred generated file was not valid.");
        chunks.push(chunk);
        offset += chunk.length;
      } while (offset < size);
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error("The transferred generated file was not valid.");
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, bytes, { mode: 0o600 });
    } catch (error) {
      blobErrors.set(
        digest,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  // Every displayed file path belongs to this cloud copy; only referenced,
  // hash-verified generated snapshots are materialized, never user folders.
  for (const turn of next.turns)
    for (const item of turn.items)
      for (const file of item.generatedFiles ?? []) {
        if (file.digest && blobErrors.has(file.digest)) {
          file.state = "unavailable";
          file.error = blobErrors.get(file.digest);
          file.path = "";
          continue;
        }
        try {
          const name =
            path.basename(file.name).replace(/[\\/\u0000-\u001f]/g, "_") ||
            "file";
          const identity =
            file.digest && /^[0-9a-f]{64}$/.test(file.digest)
              ? file.digest
              : createHash("sha256").update(file.id).digest("hex").slice(0, 16);
          const saved = path.join(
            next.cwd!,
            "device-files",
            `${identity}-${name}`,
          );
          if (file.digest && /^[0-9a-f]{64}$/.test(file.digest)) {
            await fs.mkdir(path.dirname(saved), {
              recursive: true,
              mode: 0o700,
            });
            await fs.copyFile(
              path.join(this.host.root, "generated-files", file.digest),
              saved,
            );
          } else if (typeof file.content === "string") {
            await fs.mkdir(path.dirname(saved), {
              recursive: true,
              mode: 0o700,
            });
            await fs.writeFile(saved, file.content, { mode: 0o600 });
          }
          file.path = saved;
          delete file.previousPath;
        } catch (error) {
          file.state = "unavailable";
          file.path = "";
          file.error = error instanceof Error ? error.message : String(error);
        }
      }
  this.current();
  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    try {
      await this.host.save(next, { retainOnFailure: true });
    } catch (error) {
      // The actual response already exists on the durably bound device.
      // Keep it while CloudStore retries; do not restore/send the prompt.
      next.chatDeviceError =
        error instanceof Error ? error.message : String(error);
      this.schedule();
    }
    this.current();
    this.host.push({ type: "conversation", conversation: next });
  }
  const existing = new Set<string>();
  for (const approval of opened.approvals ?? []) {
    const id = approvalPrefix + JSON.stringify([binding.deviceId, approval.id]);
    existing.add(id);
    const actualApproval = { ...approval, id, conversationId: next.id };
    const changed =
      JSON.stringify(this.approvals.get(id)?.approval) !==
      JSON.stringify(actualApproval);
    this.approvals.set(id, {
      binding,
      remoteId: approval.id,
      logicalId: next.id,
      approval: actualApproval,
    });
    if (changed)
      this.host.push({
        type: "approval",
        approval: { ...approval, id, conversationId: next.id },
      });
  }
  for (const [id, approval] of this.approvals)
    if (approval.logicalId === next.id && !existing.has(id)) {
      this.approvals.delete(id);
      this.host.push({ type: "approval-resolved", id });
    }
  if (next.turns.some((turn) => turn.status === "inProgress")) this.schedule();
  return next;
}
