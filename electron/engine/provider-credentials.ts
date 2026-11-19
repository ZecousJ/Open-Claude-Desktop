import { noteActivationPhase, activationLocalError, captureActivationPriorFailure, noteActivationPriorFailure, type ActivationPriorFailure } from "../account/activation-failure";
import { assertAccountOperationCurrent, type AccountOperationCurrent } from "../account/operation-lease";
import { credentialOperation } from "./credential-operation-queue";
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
  recognizes?(value: Buffer): boolean;
}
export class ProviderCredentials {
  private masterKey = "";
  private persistent = false;
  private availability: Record<string, boolean> = {};
  private generation = 0;
  private operation<T>(current: AccountOperationCurrent | undefined, run: (check: () => void, uncertain: () => void) => Promise<T>) {
    const generation = this.generation;
    const owned = () => generation === this.generation && (!current || current());
    return credentialOperation(this.root, owned, async (uncertain) => {
      const check = () => assertAccountOperationCurrent(owned);
      check();
      const result = await run(check, uncertain);
      check();
      return result;
    });
  }
  private async close(service: ProviderServiceClient, uncertain: () => void) {
    try { await service.close(); }
    catch { uncertain(); throw activationLocalError("credential_close_unconfirmed", "Provider credential cleanup could not confirm the provider process stopped."); }
  }
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
      throw activationLocalError("credential_unlock_unavailable", "OS encrypted storage is required to unlock provider keys.");
    if (fs.existsSync(filename)) {
      if (!this.cipher.isEncryptionAvailable())
        throw activationLocalError("credential_unlock_unavailable",
          "OS encrypted storage is required to unlock provider keys.",
        );
      const value = this.cipher.decryptString(fs.readFileSync(filename));
      if (!/^[a-f0-9]{64}$/.test(value))
        throw activationLocalError("credential_master_invalid", "Provider vault master key is invalid.");
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
  async initialize(providers: Provider[], current?: AccountOperationCurrent) {
    try { return await this.operation(current, (check, uncertain) => this.initializeOwned(providers, check, uncertain)); }
    catch (error) { noteActivationPhase(error, "credentials.queue"); throw error; }
  }
  private async initializeOwned(providers: Provider[], check: () => void, uncertain: () => void) {
    let diagnosticPhase = "credentials.validate";
    try {
    check();
    if (!providers.length)
      throw activationLocalError("credential_providers_missing", "At least one model provider is required.");
    diagnosticPhase = "credentials.master";
    this.master();
    const ids = providers.map((provider) => provider.id),
      legacy = path.join(this.root, "secrets.enc");
    const backendVault = path.join(this.root, "backend", "provider-keys.enc");
    diagnosticPhase = "credentials.client";
    const service = this.client(providers[0]);
    let priorFailure: ActivationPriorFailure | undefined;
    try {
    diagnosticPhase = "credentials.legacy";
      if (
        !fs.existsSync(backendVault) &&
        fs.existsSync(legacy) &&
        fs.statSync(legacy).size
      ) {
        if (!this.persistent)
          throw activationLocalError("credential_migration_unavailable",
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
          throw activationLocalError("credential_legacy_invalid", "Legacy provider keys are invalid.");
        const matching = Object.fromEntries(
          Object.entries(parsed).filter(([id]) => ids.includes(id)),
        ) as Record<string, string>;
        if (Object.keys(matching).length) {
    diagnosticPhase = "credentials.set_keys";
          const availability = await service.setKeys(matching, ids);
          check();
          this.availability = availability;
          fs.rmSync(legacy);
        } else { diagnosticPhase = "credentials.key_status"; const availability = await service.keyStatus(ids); check(); this.availability = availability; }
      } else {
    diagnosticPhase = "credentials.key_status";
        const availability = await service.keyStatus(ids);
        check();
        this.availability = availability;
        if (fs.existsSync(legacy) && fs.statSync(legacy).size === 0)
          fs.rmSync(legacy);
      }
    } catch (error) { noteActivationPhase(error, diagnosticPhase); priorFailure = captureActivationPriorFailure(error, diagnosticPhase); throw error; } finally {
      const operationPhase = diagnosticPhase;
      diagnosticPhase = "credentials.close";
      try { await this.close(service, uncertain); }
      catch (error) { if (priorFailure) noteActivationPriorFailure(error, priorFailure); throw error; }
      diagnosticPhase = operationPhase;
    }
    } catch (error) { noteActivationPhase(error, diagnosticPhase); throw error; }
  }
  async setKeys(patch: Record<string, string>, providers: Provider[], current?: AccountOperationCurrent) {
    return this.operation(current, (check, uncertain) => this.setKeysOwned(patch, providers, check, uncertain));
  }
  private async setKeysOwned(patch: Record<string, string>, providers: Provider[], check: () => void, uncertain: () => void) {
    check();
    if (!this.persistent && Object.values(patch).some(Boolean))
      throw Error("OS encrypted storage is required to save provider keys.");
    const service = this.client(providers[0]);
    try {
      const availability = await service.setKeys(
        patch,
        providers.map((provider) => provider.id),
      );
      check();
      this.availability = availability;
      return this.availability;
    } finally {
      await this.close(service, uncertain);
    }
  }
  async importAccountVault(profileRoot: string, providers: Provider[], current?: AccountOperationCurrent) {
    return this.operation(current, (check, uncertain) => this.importOwned(profileRoot, providers, check, uncertain));
  }
  private async importOwned(profileRoot: string, providers: Provider[], check: () => void, uncertain: () => void) {
    check();
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
    await this.setKeysOwned(patch, providers, check, uncertain);
    check();
    fs.rmSync(oldVaultFile);
    fs.rmSync(oldMasterFile);
    return true;
  }
  async testProvider(provider: Provider, temporaryKey?: string, current?: AccountOperationCurrent) {
    return this.operation(current, async (check, uncertain) => {
    check();
    const service = this.client(provider);
    try {
      return await service.testProvider(provider, temporaryKey ?? "");
    } finally {
      await this.close(service, uncertain);
    }
    });
  }
  /** Sub2API gateway reads with the stored device key, run in a provider child. */
  async remote(provider: Provider, route: "models" | "usage", apiKey = "", current?: AccountOperationCurrent) {
    return this.operation(current, async (check, uncertain) => {
    check();
    const service = this.client(provider);
    try {
      return route === "models"
        ? await service.remoteModels(provider, apiKey)
        : await service.remoteKeyUsage(provider, apiKey);
    } finally {
      await this.close(service, uncertain);
    }
    });
  }
  clear() {
    this.generation++;
    this.masterKey = "";
    this.availability = {};
    this.persistent = false;
  }
}
