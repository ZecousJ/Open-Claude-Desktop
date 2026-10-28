import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { DeviceInfo } from "../../shared/remote-devices";
import type { IpcHandle } from "../app/app-context";
import { DeviceRegistration } from "./device-registration";
import { DeviceTrustStore } from "./device-trust-store";

export interface AccountDeviceOwner {
  profileRoot: string;
  accountScope: string;
  identity: Pick<DeviceInfo, "id" | "name" | "platform" | "version">;
}
export interface AccountDeviceState {
  registration: DeviceRegistration;
  trust: DeviceTrustStore;
}

/** One live owner, with durable files separated by profile and service account.
 * A retired owner never becomes current again merely because its IDs match. */
export class AccountDeviceStateCache {
  private saved?: { key: string; value: AccountDeviceState };
  constructor(
    private dataRoot: () => string,
    private changed: () => void,
    private now: () => number = Date.now,
  ) {}
  current(
    owner: AccountDeviceOwner | undefined,
  ): AccountDeviceState | undefined {
    if (!owner) {
      this.saved = undefined;
      return;
    }
    const key = JSON.stringify([
      owner.profileRoot,
      owner.accountScope,
      owner.identity,
    ]);
    if (this.saved?.key === key) return this.saved.value;
    const profile = createHash("sha256")
      .update(owner.profileRoot)
      .digest("hex");
    const directory = path.join(this.dataRoot(), "device-state", profile);
    const value = {
      registration: new DeviceRegistration(
        directory,
        owner.accountScope,
        owner.identity,
        this.now,
      ),
      trust: new DeviceTrustStore(
        directory,
        owner.accountScope,
        owner.identity.id,
        this.now,
        this.changed,
      ),
    };
    this.saved = { key, value };
    return value;
  }
}

/** Registered only on the authenticated local app IPC, never the relay or runner. */
export function registerDeviceTrustHandlers(
  handle: IpcHandle,
  state: () => AccountDeviceState | undefined,
) {
  const trust = () => {
    const current = state();
    if (!current) throw Error("Sign in to Claudex again.");
    return current.trust;
  };
  const client = z.string().regex(/^[a-f0-9]{64}$/);
  handle("deviceTrustState", () => trust().state());
  handle("setRequireTrustedDevices", (value: unknown) =>
    trust().setRequired(z.boolean().parse(value)),
  );
  handle("approveDeviceTrust", (id: unknown, fingerprint: unknown) =>
    trust().approve(client.parse(id), z.string().max(100).parse(fingerprint)),
  );
  handle("rejectDeviceTrust", (id: unknown) =>
    trust().reject(client.parse(id)),
  );
  handle("revokeDeviceTrust", (id: unknown) =>
    trust().revoke(client.parse(id)),
  );
}
