import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../../shared/types";
import { ProviderServiceClient } from "./provider-service-client";
import { ProviderVault } from "../../server/provider-vault";

export interface StorageCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export class ProviderCredentials {
  private masterKey = "";
  private persistent = false;
  private availability: Record<string, boolean> = {};
  constructor(
    private root: string,
    private script: string,
    private cipher: StorageCipher,
  ) {}
  get vaultKey() {
    return this.masterKey;
  }
  /** Keys can be saved; without OS encryption they live only in memory. */
  get canPersist() {
    return this.persistent;
  }
  has(id: string) {
    return Boolean(this.availability[id]);
  }
  private master() {
    const filename = path.join(this.root, "provider-master.enc");
    if (
      !this.cipher.isEncryptionAvailable() &&
      [
        "backend/provider-keys.enc",
        "backend/bootstrap-secret.json",
        "secrets.enc",
      ].some((relative) => fs.existsSync(path.join(this.root, relative)))
    )
      throw Error("OS encrypted storage is required to unlock provider keys.");
    if (fs.existsSync(filename)) {
      if (!this.cipher.isEncryptionAvailable())
        throw Error(
          "OS encrypted storage is required to unlock provider keys.",
        );
      const value = this.cipher.decryptString(fs.readFileSync(filename));
      if (!/^[a-f0-9]{64}$/.test(value))
        throw Error("Provider vault master key is invalid.");
      this.masterKey = value;
      this.persistent = true;
      return;
    }
    this.masterKey = randomBytes(32).toString("hex");
    this.persistent = this.cipher.isEncryptionAvailable();
    if (this.persistent) {
      const temporary = `${filename}.tmp`;
      fs.writeFileSync(temporary, this.cipher.encryptString(this.masterKey), {
        mode: 0o600,
      });
      fs.renameSync(temporary, filename);
    }
  }
  private client(provider: Provider) {
    return new ProviderServiceClient(
      this.script,
      this.root,
      provider,
      "",
      this.masterKey,
    );
  }
  async initialize(providers: Provider[]) {
    if (!providers.length)
      throw Error("At least one model provider is required.");
    this.master();
    const ids = providers.map((provider) => provider.id),
      legacy = path.join(this.root, "secrets.enc");
    const backendVault = path.join(this.root, "backend", "provider-keys.enc");
    const service = this.client(providers[0]);
    try {
      if (
        !fs.existsSync(backendVault) &&
        fs.existsSync(legacy) &&
        fs.statSync(legacy).size
      ) {
        if (!this.persistent)
          throw Error(
            "OS encrypted storage is required to migrate provider keys.",
          );
        const parsed: unknown = JSON.parse(
          this.cipher.decryptString(fs.readFileSync(legacy)),
        );
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.entries(parsed).some(
            ([id, key]) =>
              !id ||
              id.length > 100 ||
              typeof key !== "string" ||
              key.length > 16000,
          )
        )
          throw Error("Legacy provider keys are invalid.");
        const matching = Object.fromEntries(
          Object.entries(parsed).filter(([id]) => ids.includes(id)),
        ) as Record<string, string>;
        if (Object.keys(matching).length) {
          this.availability = await service.setKeys(matching, ids);
          fs.rmSync(legacy);
        } else this.availability = await service.keyStatus(ids);
      } else {
        this.availability = await service.keyStatus(ids);
        if (fs.existsSync(legacy) && fs.statSync(legacy).size === 0)
          fs.rmSync(legacy);
      }
    } finally {
      await service.close();
    }
  }
  async setKeys(patch: Record<string, string>, providers: Provider[]) {
    if (!this.persistent && Object.values(patch).some(Boolean))
      throw Error("OS encrypted storage is required to save provider keys.");
    const service = this.client(providers[0]);
    try {
      this.availability = await service.setKeys(
        patch,
        providers.map((provider) => provider.id),
      );
      return this.availability;
    } finally {
      await service.close();
    }
  }
  async importAccountVault(profileRoot: string, providers: Provider[]) {
    const oldMasterFile = path.join(profileRoot, "provider-master.enc");
    const oldVaultFile = path.join(profileRoot, "backend", "provider-keys.enc");
    if (!fs.existsSync(oldMasterFile) || !fs.existsSync(oldVaultFile))
      return false;
    if (!this.cipher.isEncryptionAvailable())
      throw Error("OS encrypted storage is required to migrate account keys.");
    const oldMaster = this.cipher.decryptString(fs.readFileSync(oldMasterFile));
    const oldVault = new ProviderVault(profileRoot, oldMaster);
    const patch = Object.fromEntries(
      providers
        .filter(
          (provider) => !this.has(provider.id) && oldVault.get(provider.id),
        )
        .map((provider) => [provider.id, oldVault.get(provider.id)]),
    );
    if (!Object.keys(patch).length) return false;
    await this.setKeys(patch, providers);
    fs.rmSync(oldVaultFile);
    fs.rmSync(oldMasterFile);
    return true;
  }
  async testProvider(provider: Provider, temporaryKey?: string) {
    const service = this.client(provider);
    try {
      return await service.testProvider(provider, temporaryKey ?? "");
    } finally {
      await service.close();
    }
  }
  /** Sub2API gateway reads with the stored device key, run in a provider child. */
  async remote(provider: Provider, route: "models" | "usage", apiKey = "") {
    const service = this.client(provider);
    try {
      return route === "models"
        ? await service.remoteModels(provider, apiKey)
        : await service.remoteKeyUsage(provider, apiKey);
    } finally {
      await service.close();
    }
  }
  clear() {
    this.masterKey = "";
    this.availability = {};
    this.persistent = false;
  }
}
