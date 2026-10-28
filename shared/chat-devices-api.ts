import { bridgeMethods } from "./bridge-methods";
import type { Attachment, Conversation, Mode } from "./types";
import type { DeviceInfo } from "./remote-devices";

export const chatDeviceVersion = 1 as const;
export const chatDeviceUnavailable =
  "This service doesn't support Chat device binding version 1.";
export const chatDeviceMigrationUnavailable =
  "This conversation's complete context cannot be moved to another device yet. Its current device was kept.";
export type ChatDevicePermission = "default" | "auto";
/** A device-local runtime copy is not another public conversation. */
export const isDeviceExecutionCopy = (
  conversation: Pick<Conversation, "deviceChatOrigin">,
) => Boolean(conversation.deviceChatOrigin);
export interface ChatDeviceOptions {
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  webSearch?: boolean;
  research?: boolean;
  thinkingMode?: "standard" | "extended";
  connectorOverrides?: Record<string, boolean>;
  connectorToolOverrides?: import("./conversation-tools").ConversationToolOverrides;
}
export interface ChatDeviceBinding {
  version: 1;
  accountScope: string;
  organizationId: null;
  deviceId: string;
  remoteConversationId: string;
  revision: number;
  permission: ChatDevicePermission;
  lastRequestId?: string;
}
export interface ChatDeviceOrigin {
  version: 1;
  accountScope: string;
  logicalConversationId: string;
  active: boolean;
  permission: ChatDevicePermission;
  /** Persisted idempotence receipt, bounded to the last accepted request. */
  lastRequestId?: string;
}
export interface ChatDeviceDirectory {
  /** Assigned runner relay supports the existing proof/handshake envelope. */
  deviceTrustRelayVersion?: 1;
  version: 1;
  accountScope: string;
  organizationId: null;
  devices: DeviceInfo[];
  /** Absent unless the actual service supplies a policy default. */
  defaultDeviceId?: string;
}
export interface ChatDeviceSendInput {
  version: 1;
  accountScope: string;
  organizationId: null;
  requestId: string;
  deviceId: string;
  expectedBindingRevision?: number;
  conversationId?: string;
  text: string;
  mode: Exclude<Mode, "code">;
  providerId: string;
  model: string;
  taskPermission: ChatDevicePermission;
  attachments: Attachment[];
  options?: ChatDeviceOptions;
}
export interface ChatDevicesAPI {
  chatDevices(): Promise<ChatDeviceDirectory>;
  sendOnChatDevice(input: ChatDeviceSendInput): Promise<Conversation>;
  setChatDevice(input: {
    version: 1;
    accountScope: string;
    organizationId: null;
    conversationId: string;
    expectedBindingRevision: number;
    deviceId: string | null;
    taskPermission: ChatDevicePermission;
  }): Promise<Conversation>;
}
export const chatDevicesMethods = bridgeMethods<ChatDevicesAPI>({
  chatDevices: true,
  sendOnChatDevice: true,
  setChatDevice: true,
});
