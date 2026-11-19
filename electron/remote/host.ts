import { ActivationCleanupUnconfirmed, activationFailurePhase, safeActivationFailureSummary, noteActivationPhase, activationFailureTrail, activationFailureCode, activationPriorFailure } from "../account/activation-failure";
import { assertAccountOperationCurrent, type AccountOperationCurrent } from "../account/operation-lease";
import { accountForcedSignedOut } from "../app/account-transition-events";
import { validGatewayEfforts } from "../../shared/gateway-signals";
/**
 * Remote mode: a Sub2API account's session, plan, device key and models, and
 * the administrator's policy for the signed-in account (package C2).
 * `electron/main.ts` calls into this file at sign-in, sign-out and for every
 * gateway refusal; everything remote-specific lives here.
 *
 * On a Claudex service, activation reads the bootstrap, registers this
 * device (`POST /claudex/devices`) and builds the provider from the plan;
 * the policy follows the service (with a cache on disk for offline starts).
 * An older Sub2API without the Claudex module keeps the legacy flow.
 */
import type { Provider, PublicAccount } from "../../shared/types";
import type { GatewayRefusalDetails } from "../../shared/claudex-contract";
import {
  settingsWithinPolicy,
  type ClientPolicy,
  type ClientUpdate,
} from "../../shared/client-policy";
import { releaseUpdate } from "../../shared/client-policy-rules";
import { signInMessages } from "../../shared/sign-in-states";
import type { ServiceReleaseNotes } from "../../shared/client-release";
import type { ApiGroups } from "../../shared/api-keys-api";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { ModelContextLimits } from "../../shared/agent-api";
import { type GatewayRefusal } from "../../server/sub2api-errors";
import type { RequestLimits } from "../../server/operator-limits";
import type { AppContext } from "../app/app-context";
import { type PolicySource } from "../account/client-policy";
import { recordDiagnostic } from "../ipc/diagnostics";
import { Sub2ApiError } from "../sub2api/http";
import type { ProviderCredentials } from "../engine/provider-credentials";
import {
  placeholderProvider,
  remoteRequestLimits,
} from "../account/remote-mode";
import {
  activeGroupIds,
  apiGroupsFor,
  catalogInGroup,
} from "../account/api-groups";
import { apiProviderOf } from "../../shared/api-keys-api";
import { preference } from "../../shared/settings-extras";
import { RemoteBackend } from "../sub2api/backend";
import type { ClaudexBootstrapSource } from "../sub2api/claudex-bootstrap";
import { type RemoteAccounts } from "../sub2api/identity";
import { signInError } from "../sub2api/identity-support";
import type { RemoteSession } from "../sub2api/session";

/** How main opens and closes an account; remote sign-in goes through it too. */
export interface AccountLifecycle {
  /** Opens the account's profile, runtime and policy; `remote` for a Sub2API account. */
  activate(
    account: PublicAccount,
    token: string,
    remote?: RemoteHost,
    current?: AccountOperationCurrent,
  ): Promise<void>;
  /** Stops everything using the profile and signs out. */
  deactivate(): Promise<void>;
  /**
   * The Sub2API account is signed in and usable (`remote.ready`): what needs
   * the service session (the phones' device link) starts now, since activate
   * runs before the session is marked ready.
   */
  ready?(): void;
}

export type SignedOutReason =
  "revoked" | "device-revoked" | "session-expired" | "password-changed";
/** What the sign-in card says under "You were signed out on this device.". */
const signedOutMessages: Record<SignedOutReason, string> = {
  revoked: "Your account was signed out on all devices.",
  "device-revoked": "This device was removed from your account.",
  "session-expired": "Your session ended. Sign in again to continue.",
  // The device key keeps working; only the session ended (decision 4).
  "password-changed": "Your password was changed. Sign in again to continue.",
};

/** Least time between two release reads caused by 426 refusals. */
const releaseRefreshMs = 30_000;

/** A failed device key issue as a diagnostic: the service's code, never its text. */
function provisionFailure(error: unknown) {
  const status = error instanceof Sub2ApiError ? error.status : 0;
  const code =
    error instanceof Sub2ApiError
      ? error.code || `HTTP_${status}`
      : "PROVISION_FAILED";
  return {
    kind: "provision_failed" as const,
    code,
    ...(status ? { context: { http_status: status } } : {}),
  };
}

/** How old the model catalog may be when a menu reads it. */
const catalogMaxAgeMs = 60_000;

/** The signed-in Sub2API account: its session, plan, device key and models. */
export class RemoteHost {
  /**
   * Set once the account finished opening. Until then sign-out, revoke-all
   * and announcements do not use the session.
   */
  ready = false;
  private refreshing?: Promise<void>;
  /** When the plan's models and the catalog were last read. */
  private modelsReadAt = 0;
  private signingOut = false;
  constructor(
    private ctx: AppContext,
    readonly backend: RemoteBackend,
    private offlineStartup = false,
  ) {}
  /**
   * Follows the service while the account is open: a session the service
   * ended closes the account on this device (revoke-all elsewhere, this
   * device removed, refresh refused), and a new bootstrap tells the window.
   */
  watch() {
    this.session.onAuthIssue = (issue) => {
      if (this.ready && this.ctx.remote === this)
        this.ctx.push({ type: "auth-issue", issue });
    };
    this.session.onSignedOut = (reason) => {
      void this.signOut(reason).catch(() => console.error("Account sign-out could not be confirmed."));
    };
    this.bootstrap.onChange((bootstrap) => {
      if (bootstrap && this.ready && this.ctx.remote === this)
        this.ctx.push({ type: "service-changed" });
    });
  }
  get accounts(): RemoteAccounts {
    return this.backend.accounts;
  }
  get session(): RemoteSession {
    return this.backend.session;
  }
  /** The account's bootstrap (Claudex services); packages C4–C7 read it here. */
  get bootstrap(): ClaudexBootstrapSource {
    return this.backend.bootstrap;
  }
  /** A Claudex service (bootstrap, device registration, server policy). */
  get claudex() {
    return this.backend.kind === "claudex";
  }
  /** This account's profile folder on this computer. */
  profileRoot(accountId: string) {
    return this.accounts.profileRoot(accountId);
  }
  /** Sub2API meters by its own windows; only the local concurrency guards stay. */
  requestLimits(accountId: string): RequestLimits {
    return remoteRequestLimits(this.ctx.dataRoot, accountId);
  }
  /** Opens the key vault, stores this device's key and reads the plan's models into the settings. */
  async prepare(credentials: ProviderCredentials, callerCurrent?: AccountOperationCurrent) {
    let diagnosticPhase = "host.credentials_initialize";
    try {
    const store = this.ctx.store, generation = this.ctx.accountActivationIdentity;
    const current = () => (!callerCurrent || callerCurrent()) &&
      this.ctx.store === store && this.ctx.accountActivationIdentity === generation;
    assertAccountOperationCurrent(current);
    // The plan's device key and model list replace the operator's providers.
    await credentials.initialize([placeholderProvider(this.accounts)], current);
    assertAccountOperationCurrent(current);
    if (this.offlineStartup) return;
    diagnosticPhase = "host.backend_prepare";
    const provider = await this.backend.prepare(credentials, current);
    assertAccountOperationCurrent(current);
    diagnosticPhase = "host.groups_in_use";
    this.backend.preferGroups(this.groupsInUse());
    store.settings.providers = [provider];
    store.settings.activeProviderId = provider.id;
    diagnosticPhase = "host.follow_group";
    this.followGroup();
    diagnosticPhase = "host.store_flush";
    store.flush();
    } catch (error) { noteActivationPhase(error, diagnosticPhase); throw error; }
  }
  /** A device key that could not be stored encrypted is handed over at start. */
  sessionKey(providerId: string) {
    return this.backend.sessionKey(providerId);
  }
  /** The other service groups' keys that could not be stored encrypted (MG). */
  groupSessionKeys(providerId: string) {
    return this.backend.groupSessionKeys(providerId);
  }
  /** Why no model can be used (balance, plan or key), in plain English. */
  get unavailableReason() {
    return this.offlineStartup ? signInMessages.unavailable : this.backend.problem?.message;
  }
  /**
   * The account as the window shows it: the plan's label from the
   * administrator's policy, else the plan (group) name.
   */
  account(account: PublicAccount): PublicAccount {
    const label = this.claudex ? this.ctx.policy().planLabel : null;
    return { ...account, plan: label || this.backend.planName };
  }
  /**
   * The catalog met with the gateway's models, narrowed to the service group
   * in use (sidebar → API); null without one.
   */
  modelCatalog(): ModelCatalog | null {
    // The bootstrap is read with the plan's models only: a catalog older
    // than a minute is read again in the background, so a placement the
    // administrator saved reaches the menus without signing in again
    // (owner, 2026-10-03: a model moved to More models stayed in the menu).
    if (this.ready && Date.now() - this.modelsReadAt > catalogMaxAgeMs) {
      this.modelsReadAt = Date.now();
      const before = JSON.stringify(this.backend.catalog);
      const wasOffline = this.offlineStartup;
      void this.refreshModels().then(
        () => {
          if (
            this.ctx.remote === this &&
            (wasOffline || JSON.stringify(this.backend.catalog) !== before)
          )
            this.ctx.push({ type: "service-changed" });
        },
        () => {},
      );
    }
    return catalogInGroup(
      this.backend.catalog,
      this.backend.serviceGroups(),
      preference(this.ctx.store.settings, "apiGroups"),
    );
  }
  /** The groups the API page lists and the one in use. */
  apiGroups(): ApiGroups {
    let origin: string | undefined;
    try {
      origin = new URL(this.backend.accounts.baseUrl).origin;
    } catch {
      origin = undefined;
    }
    return {
      ...apiGroupsFor(
        this.backend.catalog,
        this.backend.serviceGroups(),
        preference(this.ctx.store.settings, "apiGroups"),
      ),
      ...(origin ? { origin } : {}),
    };
  }
  /** The ids of the groups in use, one per provider. */
  private groupsInUse() {
    return activeGroupIds(
      this.backend.serviceGroups(),
      preference(this.ctx.store.settings, "apiGroups"),
    );
  }
  /**
   * Uses a group's models for its provider: remembered in the settings, the
   * provider's default model follows, and the window hears of both.
   */
  async useGroup(providerId: string, id: number): Promise<ApiGroups> {
    const group = this.backend.serviceGroups().find((item) => item.id === id);
    if (
      !group ||
      group.drawing ||
      apiProviderOf(group.platform).id !== providerId
    )
      throw new Error("That group isn't available to your account.");
    const { store, accountActivationIdentity: activation } = this.ctx;
    const current = () => this.ctx.remote === this && this.ctx.store === store &&
      this.ctx.accountActivationIdentity === activation && !this.ctx.accountRetiring;
    assertAccountOperationCurrent(current);
    await store.persistApiPreferences((settings) => ({
      apiGroups: { ...preference(settings, "apiGroups"), [providerId]: id },
    }), current);
    assertAccountOperationCurrent(current);
    this.backend.preferGroups(this.groupsInUse());
    const provider = this.backend.provider;
    if (!provider) throw Error("The active model provider is unavailable.");
    store.settings.providers = [provider];
    this.followGroup();
    await this.updateRunningRoutes(provider);
    assertAccountOperationCurrent(current);
    this.ctx.settingsChanged();
    return this.apiGroups();
  }
  private async updateRunningRoutes(provider: Provider, keysChanged = false) {
    const { engine } = this.ctx;
    const refreshedKeys = keysChanged
      ? { apiKey: this.sessionKey(provider.id), groupKeys: this.groupSessionKeys(provider.id) }
      : undefined;
    await Promise.all((engine.peers?.all() ?? [engine]).map((peer) =>
      peer.providerId === provider.id && !peer.intentionalStop
        ? peer.gateway?.setProviderRouting(provider, refreshedKeys)
        : undefined,
    ));
  }
  /** The provider's default model is one the group in use serves. */
  private followGroup() {
    const provider = this.ctx.store.settings.providers[0];
    const defaultModel = catalogInGroup(
      this.backend.catalog,
      this.backend.serviceGroups(),
      preference(this.ctx.store.settings, "apiGroups"),
    )?.defaultModel;
    if (provider && defaultModel) provider.model = defaultModel;
  }
  /** Cached only: unlike modelCatalog(), never starts a refresh. */
  modelEfforts(providerId: string, model: string): string[] | undefined {
    if (providerId !== this.backend.provider?.id) return undefined;
    const catalog = catalogInGroup(
      this.backend.catalog,
      this.backend.serviceGroups(),
      preference(this.ctx.store.settings, "apiGroups"),
    );
    const items = catalog?.items.filter((item) => item.id === model);
    if (!items || items.length !== 1) return undefined;
    const efforts = items[0].efforts;
    if (efforts === undefined) return [];
    return validGatewayEfforts(efforts) ? [...efforts] : undefined;
  }
  /** The catalog's context window and compaction threshold for a model of this account. */
  modelLimits(
    providerId: string,
    model: string,
  ): ModelContextLimits | undefined {
    if (providerId !== this.backend.provider?.id) return undefined;
    const item = this.backend.catalog?.items.find(
      (entry) => entry.id === model,
    );
    if (!item || (!item.contextWindow && !item.autoCompactTokens))
      return undefined;
    return {
      ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
      ...(item.autoCompactTokens
        ? { autoCompactTokens: item.autoCompactTokens }
        : {}),
    };
  }
  /** Reads the plan's models again; concurrent calls share one read. */
  refreshModels() {
    this.refreshing ??= this.readModels().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  /**
   * After a redeemed code or a paid order: the bootstrap again (a new plan
   * registers the device key into it) and the plan's models.
   */
  refreshPlan(): Promise<void> {
    return this.refreshModels();
  }
  private async readModels() {
    this.modelsReadAt = Date.now();
    const { store, engine, credentials, accountActivationIdentity: activation } = this.ctx;
    const current = () => this.ctx.remote === this && this.ctx.store === store &&
      this.ctx.engine === engine && this.ctx.credentials === credentials &&
      this.ctx.accountActivationIdentity === activation && !this.ctx.accountRetiring;
    const before = store.settings.providers[0];
    const registrations = this.backend.registrations;
    const provider = await this.backend.prepare(credentials, current);
    assertAccountOperationCurrent(current);
    this.offlineStartup = false;
    this.backend.preferGroups(this.groupsInUse());
    // A group whose models could not be read is read again ten seconds on
    // (the next menu read), not a minute.
    if (this.backend.unreadGroups)
      this.modelsReadAt = Date.now() - catalogMaxAgeMs + 10_000;
    store.settings.providers = [provider];
    store.settings.activeProviderId = provider.id;
    this.followGroup();
    store.flush();
    engine.unavailableReason = this.unavailableReason;
    const beforeKeys = before?.routes?.map(({ keyId }) => keyId) ?? [];
    const nextKeys = provider.routes?.map(({ keyId }) => keyId) ?? [];
    const keysChanged = registrations !== this.backend.registrations || beforeKeys.length !== nextKeys.length ||
      nextKeys.some((id) => !beforeKeys.includes(id));
    if (provider.protocol !== before?.protocol && !engine.isBusy()) {
      await engine.stop(current);
      assertAccountOperationCurrent(current);
    }
    await this.updateRunningRoutes(provider, keysChanged);
    assertAccountOperationCurrent(current);
  }
  /**
   * After the gateway refused the device key: issues it again and hands it
   * to the running provider child. A failure is reported (with consent) as
   * `provision_failed` and rethrown.
   */
  async reprovision() {
    const store = this.ctx.store, engine = this.ctx.engine, generation = this.ctx.accountActivationIdentity;
    const gateway = engine.gateway, stopped = engine.intentionalStop, credentials = this.ctx.credentials;
    const current = () => this.ctx.remote === this && this.ctx.store === store &&
      this.ctx.engine === engine && engine.gateway === gateway && engine.intentionalStop === stopped &&
      this.ctx.credentials === credentials && this.ctx.accountActivationIdentity === generation && !this.ctx.accountRetiring;
    assertAccountOperationCurrent(current);
    try {
      return await this.backend.reprovision(async (key, groupKeys) => {
        assertAccountOperationCurrent(current);
        const provider = this.backend.provider;
        if (!provider) throw Error("The provider configuration is not available to update its key.");
        if (this.backend.keyInVault && !gateway) {
          if (!credentials) throw Error("Provider credential storage is not available.");
          // A stopped/cold engine has no child to persist the new key. Keep the
          // same vault format and authority; future start reads this exact root.
          const providers = [provider, ...Object.keys(groupKeys).map(id => ({ ...provider, id, routes: [] }))];
          await credentials.setKeys({ [provider.id]: key, ...groupKeys }, providers, current);
          assertAccountOperationCurrent(current);
        }
        // Memory-backed reprovision already updated backend.sessionKey, which
        // future start reads. Running children/peers are updated without starting one.
        await engine.updateProviderKey(provider.id, key, this.backend.keyInVault, groupKeys, current);
        assertAccountOperationCurrent(current);
      }, current);
    } catch (error) {
      assertAccountOperationCurrent(current);
      recordDiagnostic(this.ctx, provisionFailure(error));
      throw error;
    }
  }
  private lastReleaseRefresh = 0;
  /**
   * The gateway said this build must update (426): the bootstrap's release
   * section is read again so the update notice and the composer's lock
   * follow at once. At most once in 30 s, however many requests fail.
   */
  refreshRelease(now = Date.now()) {
    if (now - this.lastReleaseRefresh < releaseRefreshMs) return false;
    this.lastReleaseRefresh = now;
    void this.bootstrap
      .refresh()
      .then(() => {
        if (this.ctx.remote === this) this.ctx.refreshPolicy();
      })
      .catch(() => {});
    return true;
  }
  recordRefusal(refusal: GatewayRefusal) {
    this.backend.recordRefusal(refusal);
  }
  /** A reply went through, so no limit is refusing requests any more. */
  clearRefusal() {
    this.backend.clearRefusal();
  }
  /**
   * "Log out" on this device: the service lets the device go first (its key
   * is turned off, a device slot frees up), which needs the access token, so
   * it runs before the session logs out. Gives up after 3 s; never throws.
   */
  async leaveDevice() {
    if (!this.claudex) return;
    try {
      await this.session.authorized((token) =>
        this.accounts.client.revokeCurrentDevice(
          token,
          this.backend.deviceId,
          3_000,
        ),
      );
    } catch (error) {
      console.error(
        "The service did not confirm this device's sign-out:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  /**
   * The service ended this device's session: the account closes (the device
   * key leaves the vault), the saved session is removed, and the window
   * returns to sign-in with the reason.
   */
  async signOut(reason: SignedOutReason, message = signedOutMessages[reason]) {
    if (!this.ready || this.ctx.remote !== this || this.signingOut) return;
    this.signingOut = true;
    const retiredStore = this.ctx.store;
    const retiredGeneration = this.ctx.accountActivationIdentity;
    this.session.onSignedOut = undefined;
    this.session.onAuthIssue = undefined;
    this.session.end();
    // The account menu then offers "Sign in again" for it.
    this.accounts.markEnded(this.session.accountId);
    let retirementPhase = retiredGeneration;
    try {
      // Desktop deactivation enters its generation synchronously, before its
      // first await. That phase may clear this Store, but not become a new one.
      const deactivating = this.ctx.deactivate();
      retirementPhase = this.ctx.accountActivationIdentity;
      await deactivating;
    } finally {
      if (retirementPhase != null && this.ctx.accountActivationIdentity === retirementPhase &&
          (this.ctx.store == null || this.ctx.store === retiredStore) &&
          (this.ctx.remote == null || this.ctx.remote === this)) {
        this.accounts.signedOutReason = reason;
        try { this.ctx.push({ type: "signed-out", reason, message }); }
        catch { console.error("Account sign-out notification was not delivered."); }
      }
      // Host-only key: a late old completion can never authorize a new UI.
      accountForcedSignedOut(retiredStore, retiredGeneration);
    }
  }
  /** The device key leaves the vault on sign-out; the service returns it at the next sign-in. */
  async release(credentials: ProviderCredentials | undefined) {
    // Nothing the service says about this session concerns the window any more.
    const session = this.backend.session as RemoteSession | undefined;
    if (session) {
      session.onSignedOut = undefined;
      session.onAuthIssue = undefined;
    }
    const provider = this.backend.provider;
    if (provider && this.backend.keyInVault)
      await credentials
        ?.setKeys({ [provider.id]: "" }, [provider])
        .catch(() => {});
  }
}

/** Opens a Sub2API account: plan, device key and models first, then its profile. */
export async function activateRemote(
  ctx: AppContext,
  accounts: RemoteAccounts,
  lifecycle: AccountLifecycle,
  session: RemoteSession,
  account: PublicAccount,
  callerCurrent?: AccountOperationCurrent,
  onPhase?: () => void,
  offline?: true,
) {
  assertAccountOperationCurrent(callerCurrent);
  const remote = new RemoteHost(ctx, new RemoteBackend(accounts, session, ctx.dataRoot), offline);
  remote.watch();
  const pending = lifecycle.activate(account, "", remote, callerCurrent);
  void pending.catch(() => {}); // Preserve observation if a synchronous callback supersedes this attempt.
  const generation = ctx.accountActivationIdentity, store = ctx.store;
  const current = () => (!callerCurrent || callerCurrent()) &&
    ctx.accountActivationIdentity === generation && ctx.store === store;
  onPhase?.();
  try {
    await pending;
    assertAccountOperationCurrent(current);
  } catch (error) {
    assertAccountOperationCurrent(current);
    const cleanup = lifecycle.deactivate();
    const retiredGeneration = ctx.accountActivationIdentity;
    onPhase?.();
    const retiredStore = ctx.store, retiredOwner = ctx.activeAccount?.id, retiredRemote = ctx.remote;
    try { await cleanup; }
    catch (cleanupError) {
      const owned = () => (!callerCurrent || callerCurrent()) &&
        ctx.accountActivationIdentity === retiredGeneration && ctx.store === retiredStore &&
        (ctx.activeAccount === undefined || ctx.activeAccount.id === retiredOwner) &&
        (ctx.remote === undefined || ctx.remote === retiredRemote);
      assertAccountOperationCurrent(owned);
      const phase = activationFailurePhase(error);
      console.error("Account activation cleanup was not confirmed.", {
        phase, code: "ACTIVATION_CLEANUP_UNCONFIRMED", storePresent: !!ctx.store,
        accountPresent: !!ctx.activeAccount, leaseCurrent: true,
        setup: safeActivationFailureSummary(error), cleanup: safeActivationFailureSummary(cleanupError),
        setupPhases: activationFailureTrail(error), cleanupPhases: activationFailureTrail(cleanupError),
        setupCode: activationFailureCode(error), cleanupCode: activationFailureCode(cleanupError),
        setupPrior: activationPriorFailure(error), cleanupPrior: activationPriorFailure(cleanupError),
      });
      throw new ActivationCleanupUnconfirmed(phase, owned, error, cleanupError);
    }
    assertAccountOperationCurrent(() => (!callerCurrent || callerCurrent()) &&
      ctx.accountActivationIdentity === retiredGeneration && !ctx.activeAccount && !ctx.store);
    // Store clearing belongs to this verified deactivation, not a new account.
    onPhase?.();
    throw signInError(error);
  }
  assertAccountOperationCurrent(current);
  if (ctx.accountRetiring !== false || ctx.activeAccount?.id !== account.id || ctx.remote !== remote)
    throw Error("The account did not finish opening.");
  remote.ready = true;
  lifecycle.ready?.();
  assertAccountOperationCurrent(current);
  if (ctx.activeAccount?.id !== account.id || ctx.remote !== remote)
    throw Error("The account changed while signing in.");
  return ctx.activeAccount;
}

/** Opens the saved Sub2API account on desktop startup. */
export async function restoreRemoteAccount(
  ctx: AppContext,
  accounts: RemoteAccounts,
  lifecycle: AccountLifecycle,
) {
  const restored = await accounts.restore(undefined, "startup");
  if (restored)
    await activateRemote(
      ctx,
      accounts,
      lifecycle,
      restored.session,
      restored.account,
      undefined,
      undefined,
      restored.offline,
    );
}

/** A refusal as the provider child forwards it (package C3 fills the details). */
export type ForwardedRefusal = GatewayRefusal & GatewayRefusalDetails;

/** The signed-in account's policy source, read now and then regularly. */
export interface PolicyHost {
  readonly source: PolicySource;
  current(): ClientPolicy;
  /** Reads the policy in the background now (unless it is fresh) and then regularly. */
  start(): void;
  /** Stops reading; later answers from the source are ignored. */
  stop(): void;
}

/** A mode the administrator no longer allows falls back to an allowed one. */
export function keepWithinPolicy(ctx: AppContext, current: ClientPolicy) {
  const within = settingsWithinPolicy(ctx.store.settings, current);
  if (!within) return false;
  ctx.store.settings = within;
  ctx.store.flush();
  return true;
}

/**
 * The update this build needs and What's new's release notes, from the
 * bootstrap's release section (the download address only ever comes from
 * here, never from a gateway refusal).
 */
export function releaseExtras(
  appVersion: string,
  backend: Pick<RemoteBackend, "bootstrap">,
): { update?: ClientUpdate; releaseNotes?: ServiceReleaseNotes } {
  const release = backend.bootstrap.current()?.release;
  if (!release) return {};
  const update = releaseUpdate(appVersion, release);
  return {
    ...(update ? { update } : {}),
    ...(release.latestVersion && release.releaseNotesMd
      ? {
          releaseNotes: {
            version: release.latestVersion,
            markdown: release.releaseNotesMd,
            ...(release.publishedAt !== null
              ? { publishedAt: release.publishedAt }
              : {}),
          },
        }
      : {}),
  };
}

/** Least time between two policy reads caused by window focus. */
export const focusRefreshMs = 60_000;
