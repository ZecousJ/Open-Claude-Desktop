/**
 * Phones controlling the account's signed-in desktops. A desktop dials the
 * device link; the service relays a phone's calls to it and its events to the
 * account's tabs (backend webhost/devices.go). The Code conversations stay on
 * the computer.
 *
 * - The link authenticates like a tab: an events ticket (auth/events-ticket)
 *   bound to the desktop's link id, offered as Sec-WebSocket-Protocol
 *   ["claudex.v1", "ticket.<t>"]. Frames are JSON objects with `t`.
 * - Desktop → service: hello, result, event, ping, pong. Service → desktop:
 *   welcome, call, cancel, ping, pong.
 * - A phone lists online desktops with GET `devicePaths.list` and calls one
 *   with POST `devicePaths.rpc(device, method)` ({args}); the answer has the
 *   web RPC shape ({ok, value} or {ok:false, error}).
 * - On the account's event stream: {type:"device-event", deviceId, event} and
 *   {type:"devices-changed"}.
 */
import type { Approval, Conversation, EnvironmentRef, Turn } from "./types";

const base = "/api/v1/claudex/web";

export const devicePaths = {
  link: `${base}/device/link`,
  list: `${base}/devices`,
  rpc: (device: string, method: DeviceMethod) =>
    `${base}/devices/${encodeURIComponent(device)}/rpc/${method}`,
} as const;

export const deviceProtocolVersion = 1;
/** Advertised bridge default. */
export const remoteSessionCapacity = 32;

/** What a desktop serves; its hello lists exactly these. */
export const deviceMethods = [
  "deviceTrustChallenge",
  "deviceTrustEnroll",
  // Settings → Account on the web (deviceTrustRemote below).
  "deviceTrustSummary",
  "deviceTrustRequire",
  "deviceTrustRevoke",
  "deliverDispatch",
  "dispatchPreferences",
  "listDispatchTasks",
  "listCodeConversations",
  "openConversation",
  "send",
  "interrupt",
  "approve",
  "listDirectories",
  "newSession",
  "endSession",
  "listModels",
  "setModel",
  "remoteControlCapacity",
  "chatDeviceImport",
  "chatDeviceSend",
  "chatDeviceOpen",
  "chatDeviceRelease",
  "chatDeviceBlob",
  "chatDeviceInterrupt",
  "chatDeviceApprove",
  "chatDeviceActivate",
] as const;
export type DeviceMethod = (typeof deviceMethods)[number];

/** One online desktop (GET devicePaths.list). */
export interface DeviceInfo {
  sessions?: { active: number; max: number };
  id: string;
  name: string;
  platform: string;
  version: string;
  connectedAt: string;
  online?: boolean;
  computerAccess?: boolean;
  chatBindingVersion?: 1;
  chatPermissionModes?: ("default" | "auto")[];
  chatModes?: ("chat" | "cowork")[];
  lastSeenAt?: string;
  addedAt?: string;
}

/** Public keys identify clients. A claimed name, OS or id never grants access. */
export interface DeviceTrustClient {
  id: string;
  name: string;
  platform: string;
  addedAt: string;
  lastSeenAt?: string;
  fingerprint: string;
}

export interface DeviceTrustState {
  requireTrustedDevices: boolean;
  trusted: DeviceTrustClient[];
  pending: DeviceTrustClient[];
}

/**
 * What another signed-in device may do to this computer's device access
 * (Settings → Account on the web), after the same verification as every
 * relay call: read it, turn Require trusted devices on and remove a trusted
 * device. Turning it off and approving a device stay on the computer, so a
 * stolen session can't trust itself.
 */
export const deviceTrustRemoteMethods = [
  "deviceTrustSummary",
  "deviceTrustRequire",
  "deviceTrustRevoke",
] as const;

/** Local, authenticated Settings bridge only; never advertised as relay methods. */
export interface DeviceTrustAPI {
  deviceTrustState(): Promise<DeviceTrustState>;
  setRequireTrustedDevices(required: boolean): Promise<DeviceTrustState>;
  approveDeviceTrust(
    id: string,
    fingerprint: string,
  ): Promise<DeviceTrustState>;
  rejectDeviceTrust(id: string): Promise<DeviceTrustState>;
  revokeDeviceTrust(id: string): Promise<DeviceTrustState>;
}

export interface DeviceTrustChallenge {
  id: string;
  nonce: string;
  accountScope: string;
  deviceId: string;
  expiresAt: number;
  requireTrustedDevices: boolean;
}

/** The relay already transports opaque args. The signature binds these exact
 * args and method to a single host-issued challenge, preventing replay. */
export interface DeviceTrustEnvelope {
  deviceTrust: { challengeId: string; signature: string };
  args: unknown[];
}

export function deviceTrustMessage(
  challenge: DeviceTrustChallenge,
  method: string,
  args: unknown[],
) {
  return JSON.stringify(["claudex-device-trust-v1", challenge, method, args]);
}

export function coworkComputerWaiting(conversation: Conversation | undefined) {
  return Boolean(
    conversation?.linkedToComputer &&
    conversation.environment?.kind === "space" &&
    (!conversation.linkedComputerOnline || !conversation.linkedComputerAccess),
  );
}

/** A Code conversation on a desktop, as the phone's list shows it. */
export interface DeviceConversationSummary {
  id: string;
  title: string;
  cwd?: string;
  environment?: EnvironmentRef;
  updatedAt: number;
  /** A turn is running. */
  running: boolean;
  /** Approvals waiting for an answer. */
  approvals: number;
  model: string;
  mode?: "code" | "cowork";
  failed?: boolean;
  readyReview?: boolean;
}

/** openConversation's answer. */
export interface DeviceConversation {
  conversation: Conversation;
  approvals: Approval[];
}

/** send's argument. */
export interface DeviceSendInput {
  conversationId: string;
  text: string;
}

/**
 * A folder the person added to Control from your phone (Settings → General,
 * the web's "Add a folder to Remote Control"): the only folders a phone may
 * start sessions in.
 */
export interface DeviceDirectory {
  path: string;
  /** The folder's last part. */
  name: string;
  /** Sessions in it that are still open (not archived). */
  sessions: number;
  /** The folder new sessions start in unless the phone picks another. */
  default: boolean;
}

/** newSession's argument; the folder must be one of listDirectories'. */
export interface DeviceNewSessionInput {
  cwd: string;
  text: string;
  providerId?: string;
  model?: string;
  mode?: "code" | "cowork";
  attachments?: { name: string; data: string }[];
}

/** newSession's answer: the session to open. */
export interface DeviceNewSessionResult {
  conversationId: string;
}

/** A model the computer can run a session on (listModels). */
export interface DeviceModel {
  providerId: string;
  id: string;
}

/** listModels' answer. */
export interface DeviceModels {
  models: DeviceModel[];
  /** What new sessions use unless the phone picks another. */
  default?: DeviceModel;
}

/** setModel's argument: the session's model from its next message on. */
export interface DeviceSetModelInput {
  conversationId: string;
  providerId: string;
  model: string;
}

/** At most this many folders are kept for the phones. */
export const remoteFoldersLimit = 50;

/**
 * A folder a phone may start sessions in: an absolute path that is not a
 * filesystem root, without `..` parts or control characters (the web's
 * "Choose a directory, not the filesystem root.").
 */
export function remoteFolderValid(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 1024)
    return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  const posix = value.startsWith("/");
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  if (!posix && !windows) return false;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) return false;
  // "/", "C:\\" and "\\\\host" alone are roots.
  const real = windows && !value.startsWith("\\\\") ? parts.slice(1) : parts;
  return value.startsWith("\\\\") ? real.length >= 2 : real.length >= 1;
}

/**
 * The events a desktop sends about its Code conversations. "conversation"
 * and "conversation-turn" only for a conversation a phone opened in the
 * last few minutes; the list hint and approvals always.
 */
export type DeviceAppEvent =
  | {
      type: "dispatch-notification";
      conversationId: string;
      title: string;
      body: string;
      tag: string;
    }
  | { type: "conversation"; conversation: Conversation }
  | {
      type: "conversation-turn";
      conversationId: string;
      turn: Turn;
      conversation?: Partial<Omit<Conversation, "id" | "turns">>;
    }
  | { type: "approval"; approval: Approval }
  | { type: "approval-resolved"; id: string | number }
  /** A conversation was added, renamed, started or finished: read the list again. */
  | { type: "device-conversations" };

/** How long an openConversation keeps a conversation's turns streaming. */
export const deviceWatchMs = 3 * 60_000;

export interface DeviceTrustSigner {
  publicKey: string;
  name: string;
  platform: string;
  sign(message: string): Promise<string>;
}

/** Uses the existing authenticated device RPC channel for both verification
 * and execution. A pending request never performs the requested operation. */
export async function trustedDeviceCall(
  raw: (method: DeviceMethod, args: unknown[]) => Promise<unknown>,
  signer: DeviceTrustSigner,
  deviceId: string,
  method: DeviceMethod,
  args: unknown[],
  current: () => boolean = () => true,
) {
  const check = () => {
    if (!current())
      throw new Error("The signed-in account changed. Try again.");
  };
  const issue = async () => {
    check();
    const value = await raw("deviceTrustChallenge", [
      {
        publicKey: signer.publicKey,
        name: signer.name,
        platform: signer.platform,
      },
    ]);
    check();
    const challenge = value as DeviceTrustChallenge;
    if (
      !challenge ||
      typeof challenge.id !== "string" ||
      typeof challenge.nonce !== "string" ||
      typeof challenge.accountScope !== "string" ||
      challenge.deviceId !== deviceId ||
      typeof challenge.expiresAt !== "number" ||
      typeof challenge.requireTrustedDevices !== "boolean"
    )
      throw new Error("Invalid device verification challenge.");
    return challenge;
  };
  const envelope = async (
    challenge: DeviceTrustChallenge,
    action: string,
    values: unknown[],
  ): Promise<DeviceTrustEnvelope> => {
    const signature = await signer.sign(
      deviceTrustMessage(challenge, action, values),
    );
    check();
    return {
      deviceTrust: { challengeId: challenge.id, signature },
      args: values,
    };
  };
  let challenge: DeviceTrustChallenge;
  try {
    challenge = await issue();
  } catch (error) {
    // Existing authenticated hosts advertise their own method inventory.
    // Only a definite unsupported-handshake response permits their legacy
    // protocol. Network/auth errors and malformed proofs never downgrade.
    const failure = error as { code?: unknown; message?: unknown };
    const legacy =
      failure?.code === "CLAUDEX_WEB_METHOD_UNAVAILABLE" ||
      failure?.message === "Not available on the web." ||
      failure?.message === "Device verification is unavailable." ||
      failure?.message === "This computer can't do that.";
    if (!legacy) throw error;
    check();
    const result = await raw(method, args);
    check();
    return result;
  }
  if (challenge.requireTrustedDevices) {
    const result = (await raw("deviceTrustEnroll", [
      await envelope(challenge, "deviceTrustEnroll", []),
    ])) as { status?: string; fingerprint?: string };
    check();
    if (result?.status !== "trusted")
      throw new Error(
        `Approve this device in Settings → Account on your computer. Verification fingerprint: ${result?.fingerprint ?? "unavailable"}`,
      );
    challenge = await issue();
  }
  const result = await raw(method, [await envelope(challenge, method, args)]);
  check();
  return result;
}

export const deviceTrustBridgeMethods: (keyof DeviceTrustAPI)[] = [
  "deviceTrustState",
  "setRequireTrustedDevices",
  "approveDeviceTrust",
  "rejectDeviceTrust",
  "revokeDeviceTrust",
];
