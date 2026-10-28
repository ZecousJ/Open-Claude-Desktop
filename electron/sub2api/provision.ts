/**
 * This device's key. On a Claudex service the service issues it
 * (`POST /api/v1/claudex/devices`, design 2.5): one key per account and
 * device, with the per-account device limit, revoke-all and the legacy-key
 * rules applied there. Only an older Sub2API without the Claudex module
 * (`GET /claudex/release` answers 404) gets the legacy flow below, which
 * writes `/api/v1/keys` itself; a Claudex service never does.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validDeviceId,
  type ClaudexDeviceRegistration,
  type ClaudexPlan,
} from "../../shared/claudex-contract";
import type { RemoteKey, Sub2ApiClient } from "./client";
import { claudexClientInfo } from "./http";
import type { RemoteSession } from "./session";

/** This installation's id, created once; it names the device's API key. */
export function deviceId(root: string) {
  const filename = path.join(root, "device-id");
  try {
    const value = fs.readFileSync(filename, "utf8").trim();
    if (validDeviceId(value)) return value;
  } catch {
    // Created below.
  }
  const value = randomUUID();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, value, { mode: 0o600 });
  return value;
}
export const deviceKeyName = (device: string) => `claudex-desktop:${device}`;

/** The computer's name, which the administrator's device list shows. */
export function deviceName() {
  const name = os.hostname().trim();
  return name || "Claudex desktop";
}

/**
 * Registers this device with the Claudex service and returns its key (for
 * the vault only; it is never logged) and the plan the service chose.
 */
export function registerDevice(
  client: Sub2ApiClient,
  session: RemoteSession,
  device: string,
  groupId?: number | null,
): Promise<ClaudexDeviceRegistration> {
  const info = claudexClientInfo();
  return session.authorized((token) =>
    client.registerDevice(token, device, {
      deviceName: deviceName(),
      platform: info.platform ?? "",
      arch: info.arch ?? "",
      appVersion: info.version ?? "",
      groupId: groupId ?? null,
    }),
  );
}

/** The service's plan in the terms the rest of the app uses. */
export function planChoice(plan: ClaudexPlan): PlanChoice {
  return {
    groupId: plan.groupId,
    name: plan.groupName,
    platform: plan.platform,
    subscribed: plan.subscribed,
    expiresAt: plan.expiresAt,
  };
}

/** The group this device's key belongs to: the person's plan. */
export interface PlanChoice {
  groupId: number;
  /** The plan label: the subscription group's name. */
  name: string;
  platform: string;
  subscribed: boolean;
  expiresAt: number | null;
}

/**
 * The active subscription whose plan lasts longest; without one, the
 * first group the account may use (a balance-billed group).
 */
export async function choosePlan(
  client: Sub2ApiClient,
  session: RemoteSession,
): Promise<PlanChoice> {
  const [subscriptions, groups] = await Promise.all([
    session.authorized((token) => client.activeSubscriptions(token)),
    session.authorized((token) => client.availableGroups(token)),
  ]);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const active = subscriptions
    .filter((item) => item.status === "active" || !item.status)
    .sort((a, b) => (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity));
  for (const subscription of active) {
    const group = subscription.group ?? byId.get(subscription.groupId);
    if (!group) continue;
    return {
      groupId: group.id,
      name: group.name,
      platform: group.platform,
      subscribed: true,
      expiresAt: subscription.expiresAt,
    };
  }
  const usable = groups
    .filter((group) => !group.status || group.status === "active")
    .sort((a, b) => a.id - b.id)[0];
  if (!usable)
    throw Error(
      "Your account has no plan on this Claudex service yet. Ask your administrator to assign one.",
    );
  return {
    groupId: usable.id,
    name: usable.name,
    platform: usable.platform,
    subscribed: false,
    expiresAt: null,
  };
}

/** Upper bound on key pages read while looking for this device's key. */
const maxPages = 20;

/**
 * Finds this device's key (`claudex-desktop:<device-id>`) or creates it in
 * the plan's group. A key left in an older plan's group is moved rather than
 * duplicated. The key is returned to the caller for the vault; it is never logged.
 */
export async function provisionDeviceKey(
  client: Sub2ApiClient,
  session: RemoteSession,
  device: string,
  plan: PlanChoice,
): Promise<RemoteKey> {
  const name = deviceKeyName(device);
  const matches: RemoteKey[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await session.authorized((token) =>
      client.listKeys(token, name, page),
    );
    matches.push(...result.items.filter((item) => item.name === name));
    if (page >= result.pages) break;
  }
  const inPlan = matches.find((item) => item.groupId === plan.groupId);
  if (inPlan) return inPlan;
  if (matches[0])
    return await session.authorized((token) =>
      client.moveKey(token, matches[0].id, plan.groupId),
    );
  return await session.authorized((token) =>
    client.createKey(token, name, plan.groupId),
  );
}

/**
 * An older Sub2API without the Claudex module only: chooses the plan here
 * and finds or creates the device key through `/api/v1/keys`.
 */
export async function legacyProvision(
  client: Sub2ApiClient,
  session: RemoteSession,
  device: string,
): Promise<{ plan: PlanChoice; key: RemoteKey }> {
  const plan = await choosePlan(client, session);
  return {
    plan,
    key: await provisionDeviceKey(client, session, device, plan),
  };
}
