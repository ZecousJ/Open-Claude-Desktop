import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  remoteFolderValid,
  remoteFolderUsesWorktree,
  remoteFoldersLimit,
  type DeviceTrustState,
} from "../../../shared/remote-devices";
import { preference } from "../../../shared/settings-extras";
import type {
  DispatchReceiver,
  DispatchReceiving,
} from "../../../shared/official-dispatch";
import type { AdapterContext } from "../api/context";
import type { NativeHandler } from "./host";

const domain = "RemoteControlServing";
const statusStore = "remoteControlServeStatus";

type MutationOutcome = {
  outcome: "applied" | "already_applied" | "declined" | "unavailable";
};
export type DispatchFolderOutcome =
  | { outcome: "applied" | "already_applied"; addedPath: string; picked: true }
  | { outcome: "declined" | "unavailable" };

type ReceivingChanges = Parameters<DispatchReceiver["update"]>[0];
type TrustChange = Parameters<DispatchReceiver["deviceAccess"]>[0];

function desktopOperation(ctx: AdapterContext, write = false) {
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const localCall = ctx.localCall;
  const check = () => {
    if (
      !owner ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation ||
      ctx.isCurrent?.() === false
    )
      throw Error("This account window has retired.");
  };
  check();
  if (!localCall || (write && ctx.readOnly))
    throw Error("Desktop Dispatch is unavailable.");
  const call = async (name: string, ...args: unknown[]) => {
    check();
    const result = await localCall(name, ...args);
    check();
    return result;
  };
  return { call, check };
}

function readPreferences(ctx: AdapterContext) {
  const settings = ctx.settings();
  return {
    enabled: preference(settings, "remoteControl"),
    notifications: preference(settings, "dispatchMobileNotifications"),
    folders: [...preference(settings, "remoteFolders")],
  };
}

export async function readDispatchReceiving(
  ctx: AdapterContext,
): Promise<DispatchReceiving> {
  return receiving(ctx, desktopOperation(ctx));
}

async function receiving(
  ctx: AdapterContext,
  { call, check }: ReturnType<typeof desktopOperation>,
): Promise<DispatchReceiving> {
  const trust = (await call("deviceTrustState")) as DeviceTrustState;
  check();
  return { ...readPreferences(ctx), trust };
}

async function writeDispatchPreferences(
  { call }: ReturnType<typeof desktopOperation>,
  { enabled, notifications }: ReceivingChanges,
) {
  await call("saveOfficialDispatchReceiving", {
    ...(enabled === undefined ? {} : { remoteControl: enabled }),
    ...(notifications === undefined
      ? {}
      : { dispatchMobileNotifications: notifications }),
  });
}

export async function setDispatchReceiving(
  ctx: AdapterContext,
  changes: ReceivingChanges,
): Promise<DispatchReceiving> {
  const operation = desktopOperation(ctx, true);
  await writeDispatchPreferences(operation, changes);
  return receiving(ctx, operation);
}

export async function addDispatchFolder(
  ctx: AdapterContext,
): Promise<DispatchFolderOutcome> {
  const { call, check } = desktopOperation(ctx, true);
  const folder = await call("chooseFolder", "Add a folder for your phone");
  if (folder === null) return { outcome: "declined" };
  if (!remoteFolderValid(folder))
    throw Error("Choose a directory, not the filesystem root.");
  const checkedFolderList = () => {
    check();
    const { folders } = readPreferences(ctx);
    if (!folders.includes(folder) && folders.length >= remoteFoldersLimit)
      throw Error(`You can add up to ${remoteFoldersLimit} folders.`);
    return folders;
  };
  if (checkedFolderList().includes(folder))
    return { outcome: "already_applied", addedPath: folder, picked: true };
  await call("saveWorkspaceTrust", folder);
  const folders = checkedFolderList();
  if (folders.includes(folder))
    return { outcome: "already_applied", addedPath: folder, picked: true };
  await call("saveOfficialDispatchReceiving", {
    remoteFolders: [...folders, folder],
  });
  return { outcome: "applied", addedPath: folder, picked: true };
}

export async function removeDispatchFolder(
  ctx: AdapterContext,
  folder: string,
): Promise<MutationOutcome> {
  const { call } = desktopOperation(ctx, true);
  const { folders } = readPreferences(ctx);
  if (!folders.includes(folder)) return { outcome: "already_applied" };
  await call("saveOfficialDispatchReceiving", {
    remoteFolders: folders.filter((item) => item !== folder),
  });
  return { outcome: "applied" };
}

export async function changeDispatchTrust(
  ctx: AdapterContext,
  input: TrustChange,
): Promise<DispatchReceiving> {
  const { call, check } = desktopOperation(ctx, true);
  if (input.action === "reject") {
    const trust = (await call("deviceTrustState")) as DeviceTrustState;
    if (
      !trust.pending.some(
        ({ id, fingerprint }) =>
          id === input.id && fingerprint === input.fingerprint,
      )
    )
      throw Error("This verification request has expired.");
  }
  const trust = (await (input.action === "approve"
    ? call("approveDeviceTrust", input.id, input.fingerprint)
    : call("rejectDeviceTrust", input.id))) as DeviceTrustState;
  check();
  return { ...readPreferences(ctx), trust };
}

export type RemoteControlServeStatus = ReturnType<typeof readServeStatus>;

function readServeStatus(ctx: AdapterContext, onBattery: boolean) {
  const signedIn = ctx.isCurrent?.() !== false && !!ctx.account()?.id;
  const available = !!ctx.localCall;
  const link = signedIn ? ctx.localRemoteControlStatus?.() : undefined;
  const permitted = Boolean(link && link.cause !== "sign_in" && !ctx.readOnly);
  const prefs = signedIn ? readPreferences(ctx) : undefined;
  const settings = signedIn ? ctx.settings() : undefined;
  const enabled = prefs?.enabled === true;
  const requested =
    signedIn && preference(ctx.settings(), "remoteControlStayReachable");
  const keepAwake = requested && enabled && link?.online;
  const listings = new Map(
    link?.folders.map((folder) => [folder.path, folder]),
  );
  const folders = (prefs?.folders ?? []).map((path) => ({
    path,
    displayName:
      listings.get(path)?.name ??
      path.split(/[\\/]/).filter(Boolean).at(-1) ??
      path,
    reason: link?.online && enabled ? "served" : "off",
    activeSessions: listings.get(path)?.sessions ?? 0,
    worktree: settings ? remoteFolderUsesWorktree(settings, path) : false,
  }));
  const reason = !available
    ? "gate_off"
    : !link
      ? "signed_out"
      : link.cause === "sign_in"
        ? "auth_stale"
        : !enabled
          ? "off"
          : !folders.length
            ? "no_folders"
            : link.online
              ? "serving"
              : "offline";
  return {
    available,
    permitted,
    reason,
    intent: enabled ? "on" : "off",
    machineName: link?.name ?? os.hostname(),
    homePath: os.homedir(),
    folders,
    atLimit: folders.length >= remoteFoldersLimit,
    limit: remoteFoldersLimit,
    activeSessions: link?.activeSessions ?? 0,
    capacity: link?.capacity ?? 0,
    spawnMode: settings ? preference(settings, "remoteControlSpawnMode") : "same-dir",
    stayReachable: {
      mode: keepAwake ? "keep_awake_fallback" : "off",
      requested,
      onBattery,
    },
  };
}

export function registerRemoteControl(
  host: {
    ctx: AdapterContext;
    on(operation: string, handler: NativeHandler): void;
    emit(domain: string, event: string, state: RemoteControlServeStatus): void;
  },
  power?: {
    isOnBatteryPower(): boolean;
    on(event: "on-battery" | "on-ac", listener: () => void): void;
    off(event: "on-battery" | "on-ac", listener: () => void): void;
  },
) {
  const { ctx } = host;
  const get = () => readServeStatus(ctx, power?.isOnBatteryPower() ?? false);
  let published = get();
  const publish = () => {
    const next = get();
    if (isDeepStrictEqual(published, next)) return;
    published = next;
    host.emit(domain, `${statusStore}_$store$_update`, next);
  };
  const toggle = async (enabled: boolean): Promise<MutationOutcome> => {
    const state = get();
    if (!state.permitted) return { outcome: "unavailable" };
    if (state.intent === (enabled ? "on" : "off"))
      return { outcome: "already_applied" };
    await writeDispatchPreferences(desktopOperation(ctx, true), { enabled });
    return { outcome: "applied" };
  };
  host.on(`${domain}.${statusStore}_$store$_getState`, get);
  host.on(`${domain}.${statusStore}_$store$_getStateSync`, get);
  host.on(`${domain}.requestEnable`, () => toggle(true));
  host.on(`${domain}.disable`, () => toggle(false));
  host.on(`${domain}.requestAddFolder`, () =>
    get().permitted ? addDispatchFolder(ctx) : { outcome: "unavailable" },
  );
  host.on(`${domain}.removeFolder`, (raw: unknown) =>
    get().permitted
      ? removeDispatchFolder(ctx, z.string().parse(raw))
      : { outcome: "unavailable" },
  );
  host.on(`${domain}.setFolderWorktree`, async (
    rawFolder: unknown,
    rawEnabled: unknown,
  ): Promise<MutationOutcome> => {
    const folder = z.string().refine(remoteFolderValid).parse(rawFolder);
    const enabled = z.boolean().parse(rawEnabled);
    const state = get();
    if (!state.permitted || !state.folders.some((row) => row.path === folder))
      return { outcome: "unavailable" };
    const mode = enabled ? "worktree" : "same-dir";
    const existing = preference(ctx.settings(), "remoteFolderSpawnModes");
    if (existing.some((override) => override.folder === folder && override.mode === mode))
      return { outcome: "already_applied" };
    const { call } = desktopOperation(ctx, true);
    await call("saveOfficialDispatchReceiving", { remoteFolderWorktree: { folder, enabled } });
    return { outcome: "applied" };
  });
  for (const operation of [
    "setFolderPinned",
    "disconnectCloudSession",
    "requestServeSessionFolder",
    "requestServeGrantedFolder",
  ])
    host.on(`${domain}.${operation}`, () => ({ outcome: "unavailable" }));
  host.on(
    "LocalAgentModeSessions.getSessionsBridgeEnabled",
    () => get().intent === "on" && get().permitted,
  );
  host.on(
    "LocalAgentModeSessions.setSessionsBridgeEnabled",
    async (raw: unknown) => {
      const result = await toggle(z.boolean().parse(raw));
      if (result.outcome === "unavailable")
        throw Error("Desktop Dispatch is unavailable.");
    },
  );
  const unsubscribe = ctx.onEvent((event) => {
    if (
      [
        "settings",
        "devices-changed",
        "service-changed",
        "conversation",
        "cowork-session-deleted",
        "resync",
      ].includes(event.type)
    )
      publish();
  });
  power?.on("on-battery", publish);
  power?.on("on-ac", publish);
  return () => {
    unsubscribe();
    power?.off("on-battery", publish);
    power?.off("on-ac", publish);
  };
}
