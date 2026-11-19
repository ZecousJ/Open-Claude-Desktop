import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AdapterContext } from "../electron/official-ui/api/context";
import type { NativeHandler } from "../electron/official-ui/native/host";
import { defaultSettings } from "../electron/store/store";
import {
  addDispatchFolder,
  changeDispatchTrust,
  readDispatchReceiving,
  registerRemoteControl,
  setDispatchReceiving,
  type RemoteControlServeStatus,
} from "../electron/official-ui/native/remote-control";
import {
  remoteFoldersLimit,
  type DeviceTrustState,
} from "../shared/remote-devices";
import type { Settings, AppEvent } from "../shared/types";

const domain = "RemoteControlServing";
const store = "remoteControlServeStatus_$store$_";

function fixture() {
  const handlers = new Map<string, NativeHandler>();
  const subscribers = new Set<(event: AppEvent) => void>();
  const events: RemoteControlServeStatus[] = [];
  const trustedWorkspaces = new Set<string>();
  let onBattery = false;
  const power = Object.assign(new EventEmitter(), {
    isOnBatteryPower: () => onBattery,
  });
  const emit = (event: AppEvent) => {
    for (const subscribe of subscribers) subscribe(event);
  };
  let identity = {};
  const pendingPhone = {
    id: "new-phone",
    name: "Phone",
    platform: "ios",
    addedAt: "2026-11-14T14:00:00Z",
    fingerprint: "5A:BC",
  };
  const trust: DeviceTrustState = {
    requireTrustedDevices: true,
    trusted: [],
    pending: [pendingPhone],
  };
  const settings: Settings = {
    ...defaultSettings,
    remoteControl: false,
    remoteFolders: [],
    dispatchMobileNotifications: false,
  };
  const state = {
    online: false,
    signedIn: true,
    pick: () => Promise.resolve<string | null>(null),
  };
  const ctx: AdapterContext = {
    root: "",
    appVersion: "0.0.0",
    account: () => ({
      id: "owner",
      email: "owner@example.test",
      name: "Owner",
    }),
    call: async () => {
      throw Error("Expected a local call.");
    },
    modelCatalog: async () => null,
    snapshot: async () => {
      throw Error("Expected a local call.");
    },
    listConversations: async () => [],
    loadConversation: async () => undefined,
    log() {},
    sessionIdentity: () => identity,
    settings: () => settings,
    localRemoteControlStatus: () =>
      state.signedIn
        ? {
            id: "desktop001",
            online: state.online,
            cause: undefined,
            name: "Owner’s desktop",
            capacity: 32,
            activeSessions: 2,
            folders: [],
          }
        : undefined,
    onEvent: (cb: (event: AppEvent) => void) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    localCall: async (name: string, ...args: unknown[]) => {
      switch (name) {
        case "chooseFolder":
          return state.pick();
        case "saveWorkspaceTrust":
          assert.equal(typeof args[0], "string");
          if (typeof args[0] === "string") trustedWorkspaces.add(args[0]);
          return;
        case "saveOfficialDispatchReceiving":
          const { remoteFolderWorktree, ...patch } = args[0] as Partial<Settings> & {
            remoteFolderWorktree?: { folder: string; enabled: boolean };
          };
          Object.assign(settings, patch);
          if (remoteFolderWorktree) {
            settings.remoteFolderSpawnModes = [
              ...(settings.remoteFolderSpawnModes ?? []).filter(
                ({ folder }) => folder !== remoteFolderWorktree.folder,
              ),
              {
                folder: remoteFolderWorktree.folder,
                mode: remoteFolderWorktree.enabled ? "worktree" : "same-dir",
              },
            ];
          }
          emit({ type: "settings", settings });
          return;
        case "deviceTrustState":
          return structuredClone(trust);
        case "approveDeviceTrust": {
          const index = trust.pending.findIndex(
            ({ id, fingerprint }) => id === args[0] && fingerprint === args[1],
          );
          if (index < 0) throw Error("This verification request has expired.");
          trust.trusted.push(...trust.pending.splice(index, 1));
          return structuredClone(trust);
        }
        case "rejectDeviceTrust":
          trust.pending = trust.pending.filter(({ id }) => id !== args[0]);
          return structuredClone(trust);
        default:
          throw Error(`Unexpected local operation: ${name}`);
      }
    },
  };
  const host = {
    ctx,
    on(name: string, fn: NativeHandler) {
      handlers.set(name, fn);
      return this;
    },
    emit(namespace: string, event: string, value: RemoteControlServeStatus) {
      if (namespace === domain && event === `${store}update`)
        events.push(value);
    },
  };
  const dispose = registerRemoteControl(host, power);
  const invoke = (operation: string, ...args: unknown[]) => {
    const handler = handlers.get(
      operation.includes(".") ? operation : `${domain}.${operation}`,
    );
    assert.ok(handler);
    return handler(...args);
  };
  return {
    ctx,
    state,
    invoke,
    status(sync = false) {
      return invoke(
        `${store}getState${sync ? "Sync" : ""}`,
      ) as RemoteControlServeStatus;
    },
    emit,
    events,
    settings,
    trustedWorkspaces,
    pendingPhone,
    dispose,
    useBattery(value: boolean) {
      onBattery = value;
      power.emit(value ? "on-battery" : "on-ac");
    },
    switchAccount() {
      identity = {};
      settings.remoteFolders = [];
    },
  };
}

test("the original controls use the desktop receiver and publish actual relay state", async () => {
  const f = fixture();
  f.state.pick = async () => "/Users/me/project";
  assert.equal(f.status(true).reason, "off");
  assert.equal(
    f.invoke("LocalAgentModeSessions.getSessionsBridgeEnabled"),
    false,
  );
  assert.deepEqual(await f.invoke("requestAddFolder", "/renderer-provided"), {
    outcome: "applied",
    addedPath: "/Users/me/project",
    picked: true,
  });
  assert.deepEqual([...f.trustedWorkspaces], ["/Users/me/project"]);
  await f.invoke("LocalAgentModeSessions.setSessionsBridgeEnabled", true);
  assert.equal(f.status().reason, "offline");
  f.state.online = true;
  f.emit({ type: "devices-changed" });
  const serving = f.status();
  assert.equal(serving.reason, "serving");
  assert.equal(serving.folders[0]?.reason, "served");
  assert.equal(serving.activeSessions, 2);
  assert.deepEqual(serving.stayReachable, {
    mode: "off",
    requested: false,
    onBattery: false,
  });
  assert.deepEqual(f.events.at(-1), serving);
  assert.equal(serving.folders[0]?.worktree, false);
  assert.deepEqual(await f.invoke("setFolderWorktree", "/Users/me/other", true), { outcome: "unavailable" });
  assert.deepEqual(
    await f.invoke("setFolderWorktree", "/Users/me/project", true),
    {
      outcome: "applied",
    },
  );
  assert.equal(f.status().folders[0]?.worktree, true);
  assert.deepEqual(await f.invoke("setFolderWorktree", "/Users/me/project", true), { outcome: "already_applied" });
  assert.deepEqual(await f.invoke("setFolderWorktree", "/Users/me/project", false), { outcome: "applied" });
  f.settings.remoteControlSpawnMode = "worktree";
  assert.equal(f.status().spawnMode, "worktree");
  assert.equal(f.status().folders[0]?.worktree, false);
  assert.deepEqual(await f.invoke("removeFolder", "/Users/me/project"), {
    outcome: "applied",
  });
  assert.equal(f.status().reason, "no_folders");
  assert.deepEqual(await f.invoke("disable"), { outcome: "applied" });
  assert.equal(
    f.invoke("LocalAgentModeSessions.getSessionsBridgeEnabled"),
    false,
  );
  assert.equal(f.status().reason, "off");
  f.dispose();
});

test("adding folders handles cancellation, duplicates, the configured limit, and window retirement", async () => {
  const f = fixture();
  assert.deepEqual(await addDispatchFolder(f.ctx), { outcome: "declined" });
  f.state.pick = async () => "/";
  await assert.rejects(addDispatchFolder(f.ctx), /filesystem root/);
  f.settings.remoteFolders = Array.from(
    { length: remoteFoldersLimit },
    (_, index) => `/projects/${index}`,
  );
  f.state.pick = async () => "/projects/1";
  assert.equal((await addDispatchFolder(f.ctx)).outcome, "already_applied");
  f.state.pick = async () => "/projects/new";
  await assert.rejects(addDispatchFolder(f.ctx), /up to 50 folders/);
  f.state.pick = async () => {
    f.switchAccount();
    return "/retired/picker";
  };
  await assert.rejects(addDispatchFolder(f.ctx), /account window has retired/);
  assert.deepEqual(f.settings.remoteFolders, []);
  assert.deepEqual([...f.trustedWorkspaces], []);
  f.dispose();
});

test("receiving preferences and phone verification report the current account’s saved state", async () => {
  const f = fixture();
  const before = await readDispatchReceiving(f.ctx);
  assert.equal(before.enabled, false);
  assert.equal(before.trust.pending.length, 1);
  const settings = await setDispatchReceiving(f.ctx, {
    enabled: true,
    notifications: true,
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.notifications, true);
  await assert.rejects(
    changeDispatchTrust(f.ctx, {
      id: f.pendingPhone.id,
      fingerprint: "other",
      action: "reject",
    }),
    /verification request has expired/,
  );
  const paired = await changeDispatchTrust(f.ctx, {
    ...f.pendingPhone,
    action: "approve",
  });
  assert.deepEqual(paired.trust.pending, []);
  assert.deepEqual(paired.trust.trusted, [f.pendingPhone]);
  f.dispose();
});

test("reachability reports the online computer’s sleep prevention and actual battery state", () => {
  const f = fixture();
  f.settings.remoteControl = true;
  f.settings.remoteControlStayReachable = true;
  f.state.online = true;
  f.emit({ type: "settings", settings: f.settings });
  const status = () => f.status().stayReachable;
  assert.deepEqual(status(), {
    mode: "keep_awake_fallback",
    requested: true,
    onBattery: false,
  });
  f.useBattery(true);
  assert.deepEqual(status(), {
    mode: "keep_awake_fallback",
    requested: true,
    onBattery: true,
  });
  assert.deepEqual(f.events.at(-1)?.stayReachable, status());
  f.state.online = false;
  assert.deepEqual(status(), { mode: "off", requested: true, onBattery: true });
  f.dispose();
});
