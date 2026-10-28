import type { DeviceInfo } from "../../shared/remote-devices";
import type { Conversation } from "../../shared/types";

/**
 * The current bridge can continue an existing Cowork task on its owning
 * computer. It cannot elect a computer for a new Chat, move a conversation, or
 * carry Chat's model and permission choice to DeviceMethods.newSession.
 *
 * Keep those operations unavailable until a real binding API exists. A checkbox
 * must describe a verified binding, not an unimplemented intention.
 * Js:3391–3540; the bridge currently exposes only CoworkDevices.route for
 * already-bound Cowork conversations.
 */
type DeviceConversation = Pick<
  Conversation,
  "id" | "mode" | "incognito" | "linkedToComputer" | "linkedComputerId"
>;

export interface ComposerDeviceContext {
  accountId: string;
  /** A new draft gets a new id, even when the account and mode stay the same. */
  draftId: string;
  mode: Conversation["mode"];
  incognito?: boolean;
  conversation?: DeviceConversation;
}

/** An explicit user intention, scoped to its account and exact draft/chat. */
export interface ComposerDeviceElection {
  accountId: string;
  target: { kind: "draft" | "conversation"; id: string };
  deviceId: string;
}

export type ComposerDeviceList =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; devices: readonly DeviceInfo[] };

export type ComposerDeviceUnavailableReason =
  | "signed-out"
  | "unsupported-mode"
  | "incognito"
  | "loading"
  | "list-unavailable"
  | "stale-selection"
  | "device-missing"
  | "device-offline"
  | "device-presence-unknown"
  | "computer-access-off"
  | "computer-access-unknown"
  | "conversation-binding-invalid"
  | "conversation-binding-fixed"
  | "chat-binding-unavailable";

export interface ComposerDeviceRow {
  device: DeviceInfo;
  /** Only the actual conversation binding may be checked. */
  checked: boolean;
  selectable: false;
  reason: ComposerDeviceUnavailableReason;
  /** connectedAt means connection start; it must never be labelled last seen. */
  connectedAt?: string;
}

export interface ComposerDeviceState {
  /** The official submenu is conditional on a real, nonempty device list. */
  visible: boolean;
  rows: ComposerDeviceRow[];
  /** No served-default or last-seen metadata exists in DeviceInfo today. */
  selectedDeviceId?: string;
  canChangeSelection: false;
  reason: ComposerDeviceUnavailableReason;
}

function contextReason(
  context: ComposerDeviceContext,
): ComposerDeviceUnavailableReason | undefined {
  if (!context.accountId) return "signed-out";
  if (context.mode !== "chat" && context.mode !== "cowork")
    return "unsupported-mode";
  if (context.incognito || context.conversation?.incognito) return "incognito";
}

function bindingOf(context: ComposerDeviceContext) {
  const conversation = context.conversation;
  if (!conversation?.linkedToComputer) return undefined;
  if (
    context.mode !== "cowork" ||
    conversation.mode !== "cowork" ||
    !conversation.id ||
    !conversation.linkedComputerId
  )
    return null;
  return {
    conversationId: conversation.id,
    deviceId: conversation.linkedComputerId,
  };
}

function deviceReason(
  device: DeviceInfo,
): ComposerDeviceUnavailableReason | undefined {
  // Do not treat a missing status as online or an absent grant as consent.
  if (device.online === false) return "device-offline";
  if (device.online !== true) return "device-presence-unknown";
  if (device.computerAccess === false) return "computer-access-off";
  if (device.computerAccess !== true) return "computer-access-unknown";
}

function devicesOf(list: ComposerDeviceList): DeviceInfo[] {
  if (list.status !== "ready") return [];
  const unique = new Map<string, DeviceInfo>();
  for (const device of list.devices) {
    if (device.id && !unique.has(device.id)) unique.set(device.id, device);
  }
  return [...unique.values()];
}

export function composerDeviceElection(
  context: ComposerDeviceContext,
  deviceId: string,
): ComposerDeviceElection {
  return {
    accountId: context.accountId,
    target: context.conversation
      ? { kind: "conversation", id: context.conversation.id }
      : { kind: "draft", id: context.draftId },
    deviceId,
  };
}

function matchesElection(
  context: ComposerDeviceContext,
  election: ComposerDeviceElection,
) {
  const target = context.conversation
    ? { kind: "conversation", id: context.conversation.id }
    : { kind: "draft", id: context.draftId };
  return (
    context.accountId === election.accountId &&
    target.kind === election.target.kind &&
    target.id === election.target.id &&
    Boolean(target.id)
  );
}

export function deriveComposerDeviceState(
  context: ComposerDeviceContext,
  list: ComposerDeviceList,
): ComposerDeviceState {
  const blocked = contextReason(context);
  const binding = bindingOf(context);
  const reason =
    blocked ??
    (list.status === "loading"
      ? "loading"
      : list.status === "error"
        ? "list-unavailable"
        : binding === null
          ? "conversation-binding-invalid"
          : binding
            ? "conversation-binding-fixed"
            : "chat-binding-unavailable");
  const devices = devicesOf(list);
  return {
    visible: !blocked && devices.length > 0,
    selectedDeviceId: binding?.deviceId,
    canChangeSelection: false,
    reason,
    rows: devices.map((device) => ({
      device,
      checked: binding?.deviceId === device.id,
      selectable: false,
      reason: blocked ?? deviceReason(device) ?? reason,
      ...(Number.isFinite(Date.parse(device.connectedAt))
        ? { connectedAt: device.connectedAt }
        : {}),
    })),
  };
}

export type ComposerDeviceSendTarget =
  | { kind: "ordinary" }
  | { kind: "device"; deviceId: string; conversationId: string }
  | { kind: "blocked"; reason: ComposerDeviceUnavailableReason };

/**
 * Call before sending if a device intention or actual binding exists. A
 * blocked result must abort sending: it is never permission to fall back
 * to the local/cloud runner. No newSession payload is manufactured here.
 */
export function resolveComposerDeviceSend(
  context: ComposerDeviceContext,
  list: ComposerDeviceList,
  election?: ComposerDeviceElection,
): ComposerDeviceSendTarget {
  const binding = bindingOf(context);
  if (!election && binding === undefined) return { kind: "ordinary" };
  const blocked = contextReason(context);
  if (blocked) return { kind: "blocked", reason: blocked };
  if (election && !matchesElection(context, election))
    return { kind: "blocked", reason: "stale-selection" };
  if (binding === null)
    return { kind: "blocked", reason: "conversation-binding-invalid" };
  if (!binding) return { kind: "blocked", reason: "chat-binding-unavailable" };
  if (election && election.deviceId !== binding.deviceId)
    return { kind: "blocked", reason: "conversation-binding-fixed" };
  if (list.status !== "ready")
    return {
      kind: "blocked",
      reason: list.status === "loading" ? "loading" : "list-unavailable",
    };
  const device = devicesOf(list).find((item) => item.id === binding.deviceId);
  if (!device) return { kind: "blocked", reason: "device-missing" };
  const unavailable = deviceReason(device);
  if (unavailable) return { kind: "blocked", reason: unavailable };
  return { kind: "device", ...binding };
}
