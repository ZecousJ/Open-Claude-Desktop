import {
  deviceRegistrationBody,
  parseDeviceList,
  parseDeviceRegistration,
  parseDeviceRevoked,
  parseNativeSessionRevoked,
  parseWebSessionRevoked,
  type ClaudexDeviceList,
  type ClaudexDeviceRegistration,
  type DeviceRegistrationRequest,
} from "../../shared/claudex-contract";
import { requestJson, type Fetch } from "./http";
import { object } from "./client-support";
import { count } from "./client-support";
import { list } from "./client-support";
import { malformed } from "./client-support";
import { key } from "./client-support";
import type { Sub2ApiClient } from "./client";

/** `POST /claudex/devices`: this device's key, created, reused, moved or rotated by the service. */
export async function registerDevice(
  this: Sub2ApiClient,
  accessToken: string,
  deviceId: string,
  request: DeviceRegistrationRequest,
): Promise<ClaudexDeviceRegistration> {
  return parseDeviceRegistration(
    await this.call("/claudex/devices", {
      method: "POST",
      token: accessToken,
      deviceId,
      body: deviceRegistrationBody(request),
    }),
  );
}

/**
 * `DELETE /claudex/devices/current`: this device leaves the account (its
 * key is turned off and a device slot frees up). Gives up after `timeoutMs`.
 */
export async function revokeCurrentDevice(
  this: Sub2ApiClient,
  accessToken: string,
  deviceId: string,
  timeoutMs = 3_000,
) {
  const limited: Fetch = (input, init) =>
    this.fetchImpl(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  return parseDeviceRevoked(
    await requestJson(limited, this.api("/claudex/devices/current"), {
      method: "DELETE",
      token: accessToken,
      deviceId,
    }),
  );
}

/**
 * `GET /claudex/devices`: the account's desktop devices (no keys), this
 * one marked current (Settings → Account → Active sessions).
 */
export async function devices(
  this: Sub2ApiClient,
  accessToken: string,
  deviceId: string,
): Promise<ClaudexDeviceList> {
  return parseDeviceList(
    await this.call("/claudex/devices", { token: accessToken, deviceId }),
  );
}

/** `DELETE /claudex/devices/:id`: signs one of the account's devices out. */
export async function revokeDevice(
  this: Sub2ApiClient,
  accessToken: string,
  deviceId: string,
  id: number,
) {
  return parseDeviceRevoked(
    await this.call(`/claudex/devices/${id}`, {
      method: "DELETE",
      token: accessToken,
      deviceId,
    }),
  );
}

/** `DELETE /claudex/web/sessions/:id`: signs one browser session out. */
export async function revokeWebSession(
  this: Sub2ApiClient,
  accessToken: string,
  id: number,
) {
  return parseWebSessionRevoked(
    await this.call(`/claudex/web/sessions/${id}`, {
      method: "DELETE",
      token: accessToken,
    }),
  );
}

/** `DELETE /claudex/native-sessions/:id`: signs one phone app out. */
export async function revokeNativeSession(
  this: Sub2ApiClient,
  accessToken: string,
  id: number,
) {
  return parseNativeSessionRevoked(
    await this.call(`/claudex/native-sessions/${id}`, {
      method: "DELETE",
      token: accessToken,
    }),
  );
}

/** One page of the user's keys whose name contains `search`. */
export async function listKeys(
  this: Sub2ApiClient,
  accessToken: string,
  search: string,
  page: number,
) {
  const query = new URLSearchParams({
    search,
    page: String(page),
    page_size: "100",
  });
  const data = object(
    await this.call(`/keys?${query}`, { token: accessToken }),
  );
  return {
    items: list(data.items).flatMap((raw) => {
      const item = key(raw);
      return item ? [item] : [];
    }),
    pages: Math.max(1, Math.min(count(data.pages) || 1, 1000)),
  };
}

export async function createKey(
  this: Sub2ApiClient,
  accessToken: string,
  name: string,
  groupId: number,
) {
  return (
    key(
      await this.call("/keys", {
        method: "POST",
        token: accessToken,
        body: { name, group_id: groupId },
      }),
    ) ?? malformed()
  );
}

export async function moveKey(
  this: Sub2ApiClient,
  accessToken: string,
  id: number,
  groupId: number,
) {
  return (
    key(
      await this.call(`/keys/${id}`, {
        method: "PUT",
        token: accessToken,
        body: { group_id: groupId },
      }),
    ) ?? malformed()
  );
}
