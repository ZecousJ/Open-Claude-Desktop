import type { Provider } from "../../shared/types";
import { type ClaudexBootstrap } from "../../shared/claudex-contract";
import {
  groupKeyId,
  mergeGroupModels,
  type GroupModels,
} from "../../shared/provider-routes";
import { catalogForModels } from "../../shared/model-catalog-api";
import { describeSub2ApiRefusal } from "../../server/sub2api-errors";
import { Sub2ApiError } from "./http";
import { deviceKeysOffMessage, noModelsMessage } from "./identity-support";
import { legacyProvision, planChoice, registerDevice } from "./provision";
import { sub2apiProviderId } from "./backend-support";
import { protocolFor } from "./backend-support";
import { otherGroups } from "./backend-support";
import { registrationsPerMinute } from "./backend-support";
import { reconnectMessage } from "./backend-support";
import { withoutPlan } from "./backend-support";
import { offline } from "./backend-support";
import type { RemoteBackend } from "./backend";
import type { KeyStore } from "./backend";

export async function load(
  this: RemoteBackend,
  keys: KeyStore,
): Promise<Provider> {
  this.kind ??= await this.accounts.serviceKind();
  if (this.kind === "legacy") return this.loadLegacy(keys);
  let boot: ClaudexBootstrap | undefined;
  try {
    boot = await this.bootstrap.fetch();
  } catch (error) {
    // Unreachable, 5xx or an answer outside the contract: carry on as
    // offline (policy from the cache); the registration below needs the
    // service anyway and reports what is wrong.
    if (!offline(error)) throw error;
  }
  if (boot && !boot.features.deviceKeys) throw Error(deviceKeysOffMessage);
  const held = (id: string) =>
    keys.canPersist
      ? (keys.has?.(id) ?? false)
      : id === sub2apiProviderId
        ? !!this.memoryKey
        : !!this.memoryGroupKeys[id];
  const inVault = held(sub2apiProviderId);
  // A group key the service lists but this device does not hold (MG).
  const missingGroupKey = (boot?.device?.keys ?? []).some(
    (key) => !key.primary && !held(groupKeyId(sub2apiProviderId, key.groupId)),
  );
  // An account without a plan group holds no key: once this sign-in
  // registered (which deleted any key it held), nothing calls for another
  // registration until a group fits (the web device has no row then, so
  // its bootstrap keeps asking for one).
  const register =
    !this.registered ||
    (!withoutPlan(boot) &&
      (!boot?.plan ||
        !boot.device ||
        boot.device.reprovisionNeeded ||
        !inVault ||
        missingGroupKey));
  const registration = register ? await this.register() : undefined;
  const plan = registration?.plan ?? boot?.plan;
  const settings = boot
    ? undefined
    : await this.accounts.publicSettings().catch(() => undefined);
  const voice = boot?.voice;
  const provider: Provider = {
    id: sub2apiProviderId,
    name: boot?.server.siteName || settings?.siteName || "Claudex",
    baseUrl: `${this.accounts.baseUrl}/v1`,
    protocol: plan?.protocol ?? "chat",
    model: "",
    models: [],
    backend: "sub2api",
    ...(voice?.available.transcription && voice.transcription.model
      ? { transcriptionModel: voice.transcription.model }
      : {}),
  };
  if (!plan || (registration && !registration.apiKey))
    return this.openWithoutPlan(keys, provider);
  this.plan = planChoice(plan);
  if (registration) {
    this.groups = otherGroups(registration);
    await this.storeKeys(keys, provider, registration);
  } else if (boot?.device)
    this.groups = boot.device.keys
      .filter((key) => !key.primary && key.groupId !== plan.groupId)
      .map(({ groupId, groupName, platform, protocol }) => ({
        groupId,
        groupName,
        platform,
        protocol,
      }));
  const catalog =
    boot?.features.modelCatalog && boot.models ? boot.models : null;
  return this.readModels(keys, provider, catalog);
}

/**
 * An account without a group Claudex can use: it signs in all the same
 * (Claudex has no subscriptions; usage runs on the balance), with no key
 * and no models, and the composer says why (`problem`).
 */
export async function openWithoutPlan(
  this: RemoteBackend,
  keys: KeyStore,
  provider: Provider,
) {
  this.plan = undefined;
  this.groups = [];
  this.lists = [];
  this.catalog = null;
  // A key of a group the account lost leaves the vault.
  const held = keys.canPersist
    ? (keys.has?.(provider.id) ?? true)
    : !!this.memoryKey;
  if (held) await this.storeKey(keys, provider, "");
  this.problem = {
    status: 200,
    code: "NO_MODELS",
    exceeded: false,
    invalidKey: false,
    message: noModelsMessage,
  };
  this.provider = provider;
  return provider;
}

/** `POST /claudex/devices`, at most twice a minute from this run. */
export async function register(this: RemoteBackend) {
  const now = this.now();
  this.registrations = this.registrations.filter((at) => now - at < 60_000);
  if (this.registrations.length >= registrationsPerMinute)
    throw Error(reconnectMessage);
  this.registrations.push(now);
  const registration = await registerDevice(
    this.client,
    this.session,
    this.deviceId,
  );
  this.registered = true;
  return registration;
}

/** An older Sub2API: the plan chosen here and the key written through `/api/v1/keys`. */
export async function loadLegacy(
  this: RemoteBackend,
  keys: KeyStore,
): Promise<Provider> {
  const settings = await this.accounts.publicSettings().catch(() => undefined);
  const { plan, key } = await legacyProvision(
    this.client,
    this.session,
    this.deviceId,
  );
  this.plan = plan;
  this.groups = [];
  const provider: Provider = {
    id: sub2apiProviderId,
    name: settings?.siteName || "Claudex",
    baseUrl: `${this.accounts.baseUrl}/v1`,
    protocol: protocolFor(plan.platform),
    model: "",
    models: [],
    backend: "sub2api",
  };
  await this.storeKey(keys, provider, key.key);
  return this.readModels(keys, provider, null);
}

/** The gateway's models for the key, met with the catalog. */
export async function readModels(
  this: RemoteBackend,
  keys: KeyStore,
  provider: Provider,
  catalog: ClaudexBootstrap["models"] | null,
) {
  const reply = await keys.remote(provider, "models", this.memoryKey);
  if (reply.ok && reply.models) {
    // The key passed the service's balance, plan and limit checks.
    this.usage.clearRefusal();
    const listed = await this.groupModels(
      keys,
      provider,
      catalog,
      reply.models,
    );
    const met = catalogForModels(catalog, listed);
    this.catalog = met.catalog;
    provider.models = met.models;
    provider.model = met.defaultModel;
    this.problem = provider.models.length
      ? undefined
      : {
          status: 200,
          code: "NO_MODELS",
          exceeded: false,
          invalidKey: false,
          message: noModelsMessage,
        };
  } else {
    this.catalog = null;
    this.problem = describeSub2ApiRefusal(reply.status, reply.body ?? "") ?? {
      status: reply.status,
      code: `HTTP_${reply.status}`,
      exceeded: false,
      invalidKey: false,
      message:
        "The Claudex service did not return a model list. Try again later.",
    };
    if (this.problem.exceeded) this.usage.recordRefusal(this.problem);
  }
  this.provider = provider;
  return provider;
}

/**
 * The models of every service group (MG): the plan group's list with each
 * other group's (read with its own key), and the routes that send each
 * model to its group. A single group leaves the provider without routes.
 */
export async function groupModels(
  this: RemoteBackend,
  keys: KeyStore,
  provider: Provider,
  catalog: ClaudexBootstrap["models"] | null,
  planModels: string[],
) {
  delete provider.routes;
  this.unreadGroups = false;
  const before = this.lists;
  this.lists = [];
  if (!this.groups.length || !this.plan) return planModels;
  const groups: GroupModels[] = [
    {
      groupId: this.plan.groupId,
      groupName: this.plan.name,
      protocol: provider.protocol,
      keyId: provider.id,
      primary: true,
      models: planModels,
    },
  ];
  for (const group of this.groups) {
    const keyId = groupKeyId(provider.id, group.groupId);
    const reply = await keys
      .remote(
        { ...provider, id: keyId, protocol: group.protocol },
        "models",
        this.memoryGroupKeys[keyId] ?? "",
      )
      .catch(() => undefined);
    if (reply?.ok && reply.models) {
      groups.push({ ...group, keyId, primary: false, models: reply.models });
      continue;
    }
    // A read that fails (the service restarting) keeps the group's last list; a
    // group never read is left out until the next read.
    this.unreadGroups = true;
    const last = before.find((item) => item.groupId === group.groupId);
    if (last && (!reply || reply.status === 0 || reply.status >= 500))
      groups.push({ ...group, keyId, primary: false, models: last.models });
  }
  if (groups.length < 2) return planModels;
  const merged = mergeGroupModels(groups, catalog, this.preferredGroups);
  provider.routes = merged.routes;
  this.lists = groups;
  this.listCatalog = catalog;
  return merged.models;
}

/**
 * The groups in use change: the models several groups list now go out
 * with their keys. The gateway reads the routes at each request.
 */
export function preferGroups(this: RemoteBackend, ids: readonly number[]) {
  this.preferredGroups = ids;
  if (this.provider?.routes && this.lists.length > 1)
    this.provider.routes = mergeGroupModels(
      this.lists,
      this.listCatalog,
      ids,
    ).routes;
}

/**
 * After the gateway refused the device key (deleted, disabled, expired, or
 * its group gone): the service issues it again (a Claudex service, at most
 * twice a minute) or it is found or created again (an older service), and
 * `apply` hands it to the running provider child's vault.
 */
export function reprovision(
  this: RemoteBackend,
  apply: (key: string, groupKeys: Record<string, string>) => Promise<void>,
) {
  this.provisioning ??= this.serial(async () => {
    let key: string;
    let groupKeys: Record<string, string> = {};
    this.kind ??= await this.accounts.serviceKind();
    if (this.kind === "legacy") {
      const legacy = await legacyProvision(
        this.client,
        this.session,
        this.deviceId,
      );
      this.plan = legacy.plan;
      key = legacy.key.key;
    } else {
      const registration = await this.register().catch((error) => {
        if (
          error instanceof Sub2ApiError &&
          error.code === "CLAUDEX_DEVICE_REGISTRATION_THROTTLED"
        )
          throw Error(reconnectMessage);
        throw error;
      });
      // The account lost every group it could use: no key to hand over.
      if (!registration.apiKey) throw Error(noModelsMessage);
      if (registration.plan) this.plan = planChoice(registration.plan);
      key = registration.apiKey.key;
      this.groups = otherGroups(registration);
      if (this.provider)
        groupKeys = this.groupKeysOf(this.provider, registration);
    }
    if (this.memoryKey) {
      this.memoryKey = key;
      this.memoryGroupKeys = groupKeys;
    }
    await apply(key, groupKeys);
  }).finally(() => {
    this.provisioning = undefined;
  });
  return this.provisioning;
}
