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
import type { PublicAccount } from "../../shared/types";
import type { GatewayRefusalDetails } from "../../shared/claudex-contract";
import {
  settingsWithinPolicy,
  type ClientPolicy,
  type ClientUpdate,
} from "../../shared/client-policy";
import { releaseUpdate } from "../../shared/client-policy-rules";
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
  imagesFor,
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
    this.session.onSignedOut = (reason) => void this.signOut(reason);
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
  async prepare(credentials: ProviderCredentials) {
    // The plan's device key and model list replace the operator's providers.
    await credentials.initialize([placeholderProvider(this.accounts)]);
    this.backend.preferredGroups = this.groupsInUse();
    const provider = await this.backend.prepare(credentials);
    const store = this.ctx.store;
    store.settings.providers = [provider];
    store.settings.activeProviderId = provider.id;
    this.followGroup();
    store.flush();
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
    return this.backend.problem?.message;
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
    // The bootstrap is read with the plan's models only: a catalog older than a
    // minute is read again in the background, so a placement the administrator
    // saved reaches the menus without signing in again.
    if (this.ready && Date.now() - this.modelsReadAt > catalogMaxAgeMs) {
      this.modelsReadAt = Date.now();
      const before = JSON.stringify(this.backend.catalog);
      void this.refreshModels().then(
        () => {
          if (
            this.ctx.remote === this &&
            JSON.stringify(this.backend.catalog) !== before
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
        preference(this.ctx.store.settings, "imageModel"),
      ),
      ...(origin ? { origin } : {}),
    };
  }
  /**
   * The image model every picture is made with: the one chosen on the API
   * page while the drawing group serves it, else the group's first; "" when
   * the account has no drawing group (each request keeps its own model).
   */
  imageModel(): string {
    return (
      imagesFor(
        this.backend.catalog,
        this.backend.serviceGroups(),
        preference(this.ctx.store.settings, "imageModel"),
      )?.selected ?? ""
    );
  }
  /** Makes every picture with this model of the drawing group. */
  useImageModel(model: string): ApiGroups {
    const images = imagesFor(
      this.backend.catalog,
      this.backend.serviceGroups(),
      model,
    );
    if (!images?.models.some((item) => item.id === model))
      throw new Error("That image model isn't available to your account.");
    const { store } = this.ctx;
    store.settings.imageModel = model;
    store.flush();
    this.ctx.settingsChanged();
    return this.apiGroups();
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
  useGroup(providerId: string, id: number): ApiGroups {
    const group = this.backend.serviceGroups().find((item) => item.id === id);
    if (
      !group ||
      group.drawing ||
      apiProviderOf(group.platform).id !== providerId
    )
      throw new Error("That group isn't available to your account.");
    const { store } = this.ctx;
    store.settings.apiGroups = {
      ...preference(store.settings, "apiGroups"),
      [providerId]: id,
    };
    this.backend.preferGroups(this.groupsInUse());
    this.followGroup();
    store.flush();
    this.ctx.settingsChanged();
    return this.apiGroups();
  }
  /** The provider's default model is one the group in use serves. */
  private followGroup() {
    const provider = this.ctx.store.settings.providers[0];
    const defaultModel = this.modelCatalog()?.defaultModel;
    if (provider && defaultModel) provider.model = defaultModel;
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
    const before = this.ctx.store.settings.providers[0]?.protocol;
    this.backend.preferredGroups = this.groupsInUse();
    const provider = await this.backend.prepare(this.ctx.credentials);
    if (this.ctx.remote !== this) return;
    // A group whose models could not be read is read again ten seconds on
    // (the next menu read), not a minute.
    if (this.backend.unreadGroups)
      this.modelsReadAt = Date.now() - catalogMaxAgeMs + 10_000;
    const { store, engine } = this.ctx;
    store.settings.providers = [provider];
    store.settings.activeProviderId = provider.id;
    store.flush();
    engine.unavailableReason = this.unavailableReason;
    // The provider child keeps its protocol; a changed plan platform restarts it at the next send.
    if (provider.protocol !== before && !engine.isBusy()) await engine.stop();
  }
  /**
   * After the gateway refused the device key: issues it again and hands it
   * to the running provider child. A failure is reported (with consent) as
   * `provision_failed` and rethrown.
   */
  async reprovision() {
    try {
      return await this.backend.reprovision(async (key, groupKeys) => {
        if (this.ctx.remote !== this || !this.backend.provider) return;
        await this.ctx.engine.updateProviderKey(
          this.backend.provider.id,
          key,
          this.backend.keyInVault,
          groupKeys,
        );
      });
    } catch (error) {
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
    this.session.onSignedOut = undefined;
    this.session.onAuthIssue = undefined;
    this.session.end();
    // The account menu then offers "Sign in again" for it.
    this.accounts.markEnded(this.session.accountId);
    try {
      await this.ctx.deactivate();
    } finally {
      this.ctx.push({ type: "signed-out", reason, message });
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
) {
  const remote = new RemoteHost(
    ctx,
    new RemoteBackend(accounts, session, ctx.dataRoot),
  );
  remote.watch();
  try {
    await lifecycle.activate(account, "", remote);
  } catch (error) {
    await lifecycle.deactivate();
    // Device limit, no plan, device keys off, too many attempts: in words.
    throw signInError(error);
  }
  remote.ready = true;
  lifecycle.ready?.();
  return ctx.activeAccount!;
}

/** Opens the Sub2API account saved at the last sign-in, if its session is still valid. */
export async function restoreRemoteAccount(
  ctx: AppContext,
  accounts: RemoteAccounts,
  lifecycle: AccountLifecycle,
) {
  const restored = await accounts.restore();
  if (restored)
    await activateRemote(
      ctx,
      accounts,
      lifecycle,
      restored.session,
      restored.account,
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
