import { saveSub2ApiConfig } from "../../server/sub2api-config";
import { type ClientPolicy } from "../../shared/client-policy";
import {
  refusalFollowUp,
  type GatewayRefusal,
} from "../../server/sub2api-errors";
import type { AppContext, IpcHandle } from "../app/app-context";
import {
  LocalPolicySource,
  RemotePolicySource,
  ServerPolicySource,
  type PolicySource,
} from "../account/client-policy";
import { registerRemoteAuthHandlers } from "../ipc/remote-auth";
import { holdGlobalLimit, pushWeeklyUsage } from "../ipc/usage";
import { PolicyCache } from "../account/policy-cache";
import { ManagedPolicySource } from "../account/managed-settings";
import { type RemoteAccounts } from "../sub2api/identity";
import {
  activateRemote,
  keepWithinPolicy,
  releaseExtras,
  focusRefreshMs,
} from "./host";
import type { AccountLifecycle, ForwardedRefusal, PolicyHost } from "./host";

/** Sign-in IPC for a Sub2API service (register, log in, two-factor, log out, revoke all). */
export function registerRemoteAccounts(
  handle: IpcHandle,
  ctx: AppContext,
  accounts: RemoteAccounts,
  lifecycle: AccountLifecycle,
) {
  registerRemoteAuthHandlers(handle, {
    accounts,
    get activeAccount() {
      return ctx.activeAccount;
    },
    get session() {
      return ctx.remote?.ready ? ctx.remote.session : undefined;
    },
    activate: (session, account) =>
      activateRemote(ctx, accounts, lifecycle, session, account),
    deactivate: () => lifecycle.deactivate(),
    leaveDevice: async () => {
      if (ctx.remote?.ready) await ctx.remote.leaveDevice();
    },
    serviceChosen: async (baseUrl) => {
      const { app } = await import("electron");
      saveSub2ApiConfig(app.getPath("userData"), baseUrl);
      // Update checks waited for a service (electron/updates/launch.ts).
      (await import("../updates/launch")).startAppUpdates(ctx);
    },
    reloadCaller: () => {
      // Taken now: outside the call `ctx.window` is the main window.
      const win = ctx.window;
      if (!win || win.isDestroyed()) return;
      // After the call's answer has gone back to the page.
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload();
      }, 0);
    },
  });
}

/**
 * The gateway refused a request: a device the service signed out ends the
 * account here, the banner holds the refusal, a refused device key is
 * issued again, the policy is read again (the refusal may come from a
 * change), and the weekly usage banner is refreshed.
 */
export function handleRefusal(ctx: AppContext, refusal: GatewayRefusal) {
  const remote = ctx.remote;
  // Only a Claudex service explains refusals; on an older one the fields
  // could come from an upstream relay and are not acted on.
  const follow = refusalFollowUp(
    refusal as ForwardedRefusal,
    remote?.claudex === true,
  );
  if (remote && follow.signOut) {
    void remote.signOut("device-revoked");
    return;
  }
  remote?.recordRefusal(refusal);
  if (remote && follow.globalLimit)
    holdGlobalLimit(remote, follow.globalLimit, refusal as ForwardedRefusal);
  if (follow.reprovision && remote)
    void remote
      .reprovision()
      .catch((error) =>
        console.error(
          "Device key could not be issued again:",
          error instanceof Error ? error.message : String(error),
        ),
      );
  // An update is required: the release section says which and where.
  if (remote && follow.refreshRelease) remote.refreshRelease();
  // A Claudex service's policy may have changed with the refusal.
  if (remote?.claudex) ctx.refreshPolicy();
  void pushWeeklyUsage(ctx);
}

/**
 * Where the signed-in account's policy comes from: the Claudex service
 * (bootstrap, then `GET /claudex/policy`), the public settings' links of an
 * older Sub2API, or `backend/policy.json` for a local account. Stored
 * settings are brought within it now and after every change, and the
 * engine checks every request against it.
 */
export function createPolicyHost(
  ctx: AppContext,
  accountId: string,
): PolicyHost {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const subscriptions: (() => void)[] = [];
  /** A newer policy from the service or the policy file: settings follow it, the window is told. */
  let managed: ManagedPolicySource | undefined;
  const changed = (next: ClientPolicy) => {
    next = managed?.apply(next) ?? next;
    if (stopped || !ctx.activeAccount) return;
    if (keepWithinPolicy(ctx, next)) ctx.settingsChanged();
    ctx.push({ type: "policy", policy: next, revision: next.revision });
    // An edit to the MCP file that waited for the policy applies now.
    if (next.localMcpEditing && ctx.mcpConfig?.error) ctx.mcpConfig.reload?.();
  };
  const remote = ctx.remote;
  let source: PolicySource;
  let server: ServerPolicySource | undefined;
  if (remote?.claudex) {
    const backend = remote.backend;
    server = new ServerPolicySource({
      load: (etag) =>
        remote.session.authorized((token) =>
          backend.client.policy(token, backend.deviceId, etag),
        ),
      cache: new PolicyCache(ctx.store.root),
      settings: () => ctx.store.settings,
      release: () => releaseExtras(ctx.appVersion, backend),
      onChange: changed,
    });
    const fromBootstrap = (policy: unknown) => {
      if (policy === undefined) server!.changed();
      else server!.accept(policy);
    };
    if (backend.bootstrap.current()?.policy)
      fromBootstrap(backend.bootstrap.rawSection("policy"));
    subscriptions.push(
      backend.bootstrap.onChange((bootstrap) => {
        if (!bootstrap || stopped) return;
        fromBootstrap(
          bootstrap.policy ? backend.bootstrap.rawSection("policy") : undefined,
        );
      }),
    );
    // The catalog's context limits apply to this account's threads (E0).
    ctx.engine.modelLimits = (providerId, model) =>
      remote.modelLimits(providerId, model);
    // Keys of the account's other service groups held in memory (MG).
    ctx.engine.groupKeys = (providerId) => remote.groupSessionKeys(providerId);
    source = server;
  } else if (remote)
    source = new RemotePolicySource(
      () => remote.accounts.publicSettings(),
      changed,
    );
  else
    source = new LocalPolicySource(
      ctx.dataRoot,
      {
        platform: process.platform,
        appVersion: ctx.appVersion,
        accountId,
      },
      changed,
    );
  managed = new ManagedPolicySource(source, changed);
  source = managed;
  keepWithinPolicy(ctx, source.current());
  ctx.engine.policy = () => ctx.policy();
  const read = async () => {
    await source.refresh();
    if (server) await server.refresh(true);
  };
  let focusedAt = 0;
  return {
    source,
    current: () => source.current(),
    start() {
      if (stopped) return;
      // The bootstrap just brought the service's policy; otherwise ask now.
      if (!server?.answered) void read();
      timer = setInterval(
        () => void read(),
        source.refreshIntervalMs ?? 60_000,
      );
      focusedAt = Date.now();
      subscriptions.push(
        ctx.onWindowFocus(() => {
          if (stopped || Date.now() - focusedAt < focusRefreshMs) return;
          focusedAt = Date.now();
          void read();
        }),
      );
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    },
  };
}
