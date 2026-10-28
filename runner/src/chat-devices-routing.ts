import { randomUUID } from "node:crypto";
import type { ChatDeviceBinding } from "../../shared/chat-devices-api";
import {
  portableChatDeviceConversation,
  setChatDeviceInput,
} from "../../shared/chat-device-context";
import { preference } from "../../shared/settings-extras";
import { approvalPrefix } from "./chat-devices-support";
import { scopeOf } from "./chat-devices-support";
import type { ChatDeviceController } from "./chat-devices";
import type { Opened } from "./chat-devices";

export async function migrate(
  this: ChatDeviceController,
  input: ReturnType<typeof setChatDeviceInput.parse>,
) {
  let conversation = this.target(input.conversationId);
  const binding = this.binding(conversation, input.expectedBindingRevision);
  if (conversation.turns.some((turn) => turn.status === "inProgress"))
    throw new Error("Stop the response before changing devices.");
  if (binding?.deviceId === input.deviceId) return conversation;
  if (binding) {
    const opened = (await this.call(binding, "chatDeviceOpen", {
      remoteConversationId: binding.remoteConversationId,
    })) as Opened;
    conversation = await this.receive(conversation, binding, opened);
  }
  const source = portableChatDeviceConversation(conversation);
  let nextBinding: ChatDeviceBinding | undefined;
  if (input.deviceId !== null) {
    await this.elected(input.deviceId, source.mode, input.taskPermission);
    const opened = (await this.call(
      { deviceId: input.deviceId },
      "chatDeviceImport",
      {
        source,
        taskPermission: input.taskPermission,
        providerId: source.providerId,
        model: source.model,
      },
    )) as Opened;
    if (
      !opened.conversation?.id ||
      opened.conversation.deviceChatOrigin?.logicalConversationId !== source.id
    )
      throw new Error("The computer couldn't confirm the Chat binding.");
    nextBinding = {
      version: 1,
      accountScope: input.accountScope,
      organizationId: null,
      deviceId: input.deviceId,
      remoteConversationId: opened.conversation.id,
      revision: (conversation.chatDeviceRevision ?? binding?.revision ?? 0) + 1,
      permission: input.taskPermission,
    };
  }
  try {
    if (binding)
      await this.call(binding, "chatDeviceRelease", {
        remoteConversationId: binding.remoteConversationId,
      });
    else await this.host.release(conversation.id);
    this.current();
    const next = {
      ...source,
      environment: conversation.environment,
      cwd: conversation.cwd,
      chatDeviceRevision:
        (conversation.chatDeviceRevision ?? binding?.revision ?? 0) + 1,
      ...(nextBinding ? { chatDeviceBinding: nextBinding } : {}),
    };
    await this.host.save(next);
    this.current();
    this.host.push({ type: "conversation", conversation: next });
    return next;
  } catch (error) {
    if (binding)
      await this.call(binding, "chatDeviceActivate", {
        remoteConversationId: binding.remoteConversationId,
      }).catch(() => {});
    if (nextBinding)
      await this.call(nextBinding, "chatDeviceRelease", {
        remoteConversationId: nextBinding.remoteConversationId,
      }).catch(() => {});
    throw error;
  }
}

export function route(
  this: ChatDeviceController,
  name: string,
  args: any[],
  fallback: () => Promise<any>,
): Promise<any> {
  this.current();
  if (
    name === "approve" &&
    typeof args[0] === "string" &&
    args[0].startsWith(approvalPrefix)
  ) {
    const approval = this.approvals.get(args[0]);
    if (!approval)
      return Promise.reject(new Error("This request was already answered."));
    const current = this.host
      .conversations()
      .find((c) => c.id === approval.logicalId)?.chatDeviceBinding;
    if (
      !current ||
      current.revision !== approval.binding.revision ||
      current.deviceId !== approval.binding.deviceId ||
      current.remoteConversationId !== approval.binding.remoteConversationId
    )
      return Promise.reject(new Error("This request was already answered."));
    return this.call(approval.binding, "chatDeviceApprove", {
      remoteConversationId: approval.binding.remoteConversationId,
      approvalId: approval.remoteId,
      result: args[1],
    });
  }
  const id = name === "send" ? args[0]?.conversationId : args[0];
  const conversation =
    typeof id === "string"
      ? this.host.conversations().find((c) => c.id === id)
      : undefined;
  const binding = conversation?.chatDeviceBinding;
  if (!conversation || !binding) return fallback();
  if (name === "send")
    return this.send({
      ...scopeOf(this.host.accountScope),
      requestId: randomUUID(),
      deviceId: binding.deviceId,
      expectedBindingRevision: binding.revision,
      conversationId: id,
      mode: conversation.mode,
      text: args[0].text,
      providerId: args[0].providerId,
      model: args[0].model,
      taskPermission: preference(this.host.settings(), "taskPermission"),
      attachments: args[0].attachments ?? [],
      options: {
        effort: args[0].effort,
        webSearch: args[0].webSearch,
        research: args[0].research,
        thinkingMode: args[0].thinkingMode,
        connectorOverrides: args[0].connectorOverrides,
        connectorToolOverrides: args[0].connectorToolOverrides,
      },
    });
  if (name === "interrupt")
    return this.call(binding, "chatDeviceInterrupt", {
      remoteConversationId: binding.remoteConversationId,
    });
  if (
    [
      "retryResponse",
      "editPrompt",
      "compactConversation",
      "forkConversation",
      "handOffConversation",
      "runShellCommand",
      "askSideChat",
      "deleteConversation",
      "releaseRunner",
    ].includes(name)
  )
    return Promise.reject(
      new Error("This action isn't supported by the Chat device protocol yet."),
    );
  return fallback();
}
