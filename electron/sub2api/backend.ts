import { drawsOnly, type ServiceGroup } from "../account/api-groups";
import type {
  PlanUsage,
  Provider,
  WeeklyUsageStatus,
} from "../../shared/types";
import {
  type ClaudexBootstrap,
  type ClaudexDeviceRegistration,
} from "../../shared/claudex-contract";
import { groupKeyId, type GroupModels } from "../../shared/provider-routes";
import { type ModelCatalog } from "../../shared/model-catalog-api";
import { type GatewayRefusal } from "../../server/sub2api-errors";
import type { RemoteReply } from "../engine/provider-service-client";
import type { WeeklyDismissal } from "../conversations/weekly-usage";
import { ClaudexBootstrapSource } from "./claudex-bootstrap";
import { type RemoteAccounts } from "./identity";
import { deviceId, type PlanChoice } from "./provision";
import type { BannerPolicy } from "./quota";
import type { RemoteSession } from "./session";
import { SubscriptionUsage, type UsageSource } from "./usage-source";
import { protocolFor } from "./backend-support";
import * as backendModels from "./backend-models";
import { installMethods } from "./install-methods";

/** The vault and gateway reads the backend needs; ProviderCredentials in the app. */
export interface KeyStore {
  setKeys(
    patch: Record<string, string>,
    providers: Provider[],
  ): Promise<Record<string, boolean>>;
  remote(
    provider: Provider,
    route: "models" | "usage",
    apiKey?: string,
  ): Promise<RemoteReply>;
  /** False without OS encryption: the key is then kept in memory for this run. */
  readonly canPersist: boolean;
  /** The vault holds a key for this provider. */
  has?(id: string): boolean;
}

/** A service group whose device key this device holds besides the plan's (MG). */
export interface KeyGroup {
  groupId: number;
  groupName: string;
  platform: string;
  protocol: Provider["protocol"];
}

/** The vault entries of a provider's group keys, as providers the vault accepts. */
function vaultProviders(provider: Provider, ids: string[]): Provider[] {
  return [provider, ...ids.map((id) => ({ ...provider, id, routes: [] }))];
}

/**
 * The signed-in account's Sub2API plan: its device key, model list, quota
 * and the refusals the gateway reported. Lives in the main process.
 *
 * On a Claudex service the bootstrap and the service's device registration
 * decide everything; an older Sub2API (no Claudex module) keeps the legacy
 * flow, where this client picks the plan and writes `/api/v1/keys`.
 */
export class RemoteBackend {
  plan?: PlanChoice;
  provider?: Provider;
  /** Why the model list is empty, in plain English. */
  problem?: GatewayRefusal;
  /** "claudex" or "legacy" once the service answered. */
  kind?: "claudex" | "legacy";
  /** The account's bootstrap (Claudex services); packages C4–C7 read it. */
  readonly bootstrap: ClaudexBootstrapSource;
  /** Plan usage and the weekly banner (package C4 after C2). */
  readonly usage: UsageSource;
  /**
   * The administrator's model catalog met with the gateway's list; null on
   * an older service or when the service publishes none.
   */
  catalog: ModelCatalog | null = null;
  provisioning?: Promise<void>;
  private lock: Promise<unknown> = Promise.resolve();
  /** The device key when it cannot be stored encrypted; the service returns it at each sign-in. */
  memoryKey = "";
  /** The other groups' keys when they cannot be stored encrypted, by vault entry (MG). */
  memoryGroupKeys: Record<string, string> = {};
  /** The account's other service groups this device holds a key for (MG). */
  groups: KeyGroup[] = [];
  /** What each group's key listed at the last read, and the catalog it was met with (several groups only). */
  lists: GroupModels[] = [];
  listCatalog: ClaudexBootstrap["models"] | null = null;
  /** The groups in use on the API page (one per provider), which serve the models several groups list. */
  preferredGroups: readonly number[] = [];
  /** This run's device registrations, for the per-minute limit. */
  registrations: number[] = [];
  /** The first load of a sign-in registers, so the vault's key is this account's. */
  registered = false;
  /** A group's models could not be read at the last read (its last list, if any, stands in). */
  unreadGroups = false;
  private device?: string;
  constructor(
    readonly accounts: RemoteAccounts,
    readonly session: RemoteSession,
    private dataRoot: string,
    public now: () => number = Date.now,
  ) {
    this.bootstrap = new ClaudexBootstrapSource((etag) =>
      session.authorized((token) =>
        accounts.client.bootstrap(token, this.deviceId, etag),
      ),
    );
    this.usage = new SubscriptionUsage(
      {
        client: accounts.client,
        session,
        publicSettings: () => accounts.publicSettings(),
        plan: () => this.plan,
        provider: () => this.provider,
        sessionKey: () => this.memoryKey,
      },
      now,
    );
  }
  get client() {
    return this.accounts.client;
  }
  /** This installation's id (`X-Claudex-Device-Id`). */
  get deviceId() {
    return (this.device ??= deviceId(this.dataRoot));
  }
  /**
   * The service groups this device holds a key for, the plan group first
   * (the API page lists them; the model menus follow the one in use).
   */
  serviceGroups(): ServiceGroup[] {
    const plan = this.plan;
    if (!plan) return [];
    return [
      {
        id: plan.groupId,
        name: plan.name,
        primary: true,
        protocol: protocolFor(plan.platform),
        platform: plan.platform,
        ...this.listed(plan.groupId),
      },
      ...this.groups
        .filter((group) => group.groupId !== plan.groupId)
        .map((group) => ({
          id: group.groupId,
          name: group.groupName,
          primary: false,
          protocol: group.protocol,
          platform: group.platform,
          ...this.listed(group.groupId),
        })),
    ];
  }
  /** The models a group's key listed at the last read, once several groups were read. */
  private listed(groupId: number) {
    const list = this.lists.find((group) => group.groupId === groupId);
    if (this.lists.length < 2) return {};
    const models = list?.models ?? [];
    return drawsOnly(models) ? { models, drawing: true } : { models };
  }
  /** The plan's name as the service calls its group. */
  get planName() {
    return this.plan?.name;
  }
  /** Chooses the plan, stores this device's key and reads the plan's models. */
  prepare(keys: KeyStore): Promise<Provider> {
    return this.serial(() => this.load(keys));
  }
  /** Key provisioning runs one at a time, so the device key is never created twice. */
  serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => {});
    return run;
  }
  groupKeysOf(
    provider: Provider,
    registration: ClaudexDeviceRegistration,
  ): Record<string, string> {
    return Object.fromEntries(
      registration.apiKeys
        .filter((key) => !key.primary)
        .map((key) => [groupKeyId(provider.id, key.groupId), key.key]),
    );
  }
  /** Stores the plan group's key and the other groups' keys (MG). */
  async storeKeys(
    keys: KeyStore,
    provider: Provider,
    registration: ClaudexDeviceRegistration,
  ) {
    const key = registration.apiKey?.key ?? "";
    const groupKeys = this.groupKeysOf(provider, registration);
    if (keys.canPersist) {
      this.memoryKey = "";
      this.memoryGroupKeys = {};
      // Entries of groups the account no longer has leave the vault.
      await keys.setKeys(
        { [provider.id]: key, ...groupKeys },
        vaultProviders(provider, Object.keys(groupKeys)),
      );
    } else {
      this.memoryKey = key;
      this.memoryGroupKeys = groupKeys;
    }
  }
  async storeKey(keys: KeyStore, provider: Provider, key: string) {
    if (keys.canPersist) {
      this.memoryKey = "";
      this.memoryGroupKeys = {};
      await keys.setKeys({ [provider.id]: key }, [provider]);
    } else {
      this.memoryKey = key;
      this.memoryGroupKeys = {};
    }
  }
  /** The key the gateway starts with when it is not in the vault. */
  sessionKey(providerId: string) {
    return providerId === this.provider?.id ? this.memoryKey : "";
  }
  /** The other service groups' keys the gateway starts with when they are not in the vault (MG). */
  groupSessionKeys(providerId: string): Record<string, string> {
    return providerId === this.provider?.id ? { ...this.memoryGroupKeys } : {};
  }
  get keyInVault() {
    return !this.memoryKey;
  }

  // ---- Usage, through the usage source (package C4 owns it after C2).

  recordRefusal(refusal: GatewayRefusal) {
    this.usage.recordRefusal(refusal);
  }
  /** A reply went through, so no limit is refusing requests any more. */
  clearRefusal() {
    this.usage.clearRefusal();
  }
  get refusal() {
    return this.usage.refusal;
  }
  progress(fresh = false) {
    return (this.usage as SubscriptionUsage).progress(fresh);
  }
  weeklyStatus(
    policy: BannerPolicy,
    dismissal: WeeklyDismissal | undefined,
    keys: KeyStore,
  ): Promise<WeeklyUsageStatus | null> {
    return this.usage.weeklyStatus(policy, dismissal, keys);
  }
  planUsage(warnPercent: number, fresh: boolean): Promise<PlanUsage | null> {
    return this.usage.planUsage(warnPercent, fresh);
  }
}

export interface RemoteBackend {
  load: OmitThisParameter<typeof backendModels.load>;
  openWithoutPlan: OmitThisParameter<typeof backendModels.openWithoutPlan>;
  register: OmitThisParameter<typeof backendModels.register>;
  loadLegacy: OmitThisParameter<typeof backendModels.loadLegacy>;
  readModels: OmitThisParameter<typeof backendModels.readModels>;
  groupModels: OmitThisParameter<typeof backendModels.groupModels>;
  preferGroups: OmitThisParameter<typeof backendModels.preferGroups>;
  reprovision: OmitThisParameter<typeof backendModels.reprovision>;
}
installMethods(RemoteBackend.prototype, backendModels);
