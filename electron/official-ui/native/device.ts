import os from "node:os";
import { createHash } from "node:crypto";
import { app } from "electron";
import { deviceDirectory } from "../api/device-registry";
import { organizationUuid } from "../api/context";
import { DeviceKeyUnavailable, runDeviceKey } from "./device-key";
import { encodeDeviceProof } from "./device-proof";
import { NativeRefusal, type NativeHost } from "./host";

export function registerDevice(host: NativeHost) {
  const { ctx } = host;
  const pending = new Map<string, Promise<unknown>>();
  const publicKeys = new Map<string, string>();
  const keylessRows = new Map<string, string>();
  const hex = createHash("sha256").update("claudex-device:" + app.getPath("userData")).digest("hex");
  const deviceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

  function lease(account: unknown) {
    const owner = ctx.account()?.id;
    const directory = ctx.stateDirectory?.();
    const identity = ctx.sessionIdentity?.();
    const check = () => {
      if (!owner || !directory || account !== owner || !ctx.isCurrent?.() ||
          ctx.account()?.id !== owner || ctx.sessionIdentity?.() !== identity)
        throw new NativeRefusal("signed_out", "DeviceRegistry: accountUuid is not the active account");
    };
    check();
    const request = ctx.deviceRegistryRequest;
    if (!owner || !directory || !request)
      throw new NativeRefusal("not_registered", "DeviceRegistry: device not registered for this account");
    return { owner, directory, orgId: organizationUuid(owner), request, check };
  }

  type Lease = ReturnType<typeof lease>;
  function run<T>(slot: Lease, operation: () => Promise<T>): Promise<T> {
    const task = (pending.get(slot.directory) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      slot.check();
      const answer = await operation();
      slot.check();
      return answer;
    });
    pending.set(slot.directory, task);
    return task.finally(() => {
      if (pending.get(slot.directory) === task) pending.delete(slot.directory);
    });
  }

  async function key(slot: Lease) {
    const value = publicKeys.get(slot.directory) ?? await runDeviceKey("public", slot.directory);
    slot.check();
    publicKeys.set(slot.directory, value);
    return value;
  }

  async function rows(slot: Lease) {
    const answer = await slot.request({ method: "GET" });
    slot.check();
    const parsed = deviceDirectory.safeParse(answer);
    if (!parsed.success) throw new NativeRefusal("row_pk_directory", "DeviceRegistry: invalid directory response");
    return parsed.data.devices.filter(row => !row.revoked_at);
  }

  function checkOrg(slot: Lease, org: unknown) {
    if (org !== slot.orgId)
      throw new NativeRefusal("bad_input", "DeviceRegistry: organization does not match the active account");
  }

  host
    .on("DeviceRegistry.getAvailability", async (account: unknown) => {
      try {
        const slot = lease(account);
        await run(slot, () => key(slot));
        return { available: true, isHardwareBacked: true };
      } catch (error) {
        if (!(error instanceof DeviceKeyUnavailable)) throw error;
        return { available: false, isHardwareBacked: false, reason: error.reason };
      }
    })
    .on("DeviceRegistry.getLocalDeviceInfo", async (account: unknown) => {
      const slot = lease(account);
      const info = { deviceId, platform: process.platform, displayName: os.hostname(), homePath: os.homedir() };
      const publicKey = publicKeys.get(slot.directory);
      const keyless = keylessRows.get(slot.directory);
      if (!publicKey && !keyless) return info;
      const registered = await rows(slot).catch(() => []);
      slot.check();
      const row = registered.find(value => value.public_key ? value.public_key === publicKey : value.id === keyless);
      return row ? { ...info, registryRowId: row.id, registryRowIdSource: row.public_key ? "keyed" : "keyless" } : info;
    })
    .on("DeviceRegistry.getPublicKey", (account: unknown) => {
      const slot = lease(account);
      return run(slot, async () => ({ publicKeySpkiB64: await key(slot), isHardwareBacked: true }));
    })
    .on("DeviceRegistry.getOwnRowPk", async (account: unknown, org: unknown) => {
      const slot = lease(account);
      checkOrg(slot, org);
      const publicKey = publicKeys.get(slot.directory);
      if (!publicKey) return {};
      const row = (await rows(slot)).find(value => value.public_key === publicKey);
      return row ? { rowPk: row.id } : {};
    })
    .on("DeviceRegistry.rotateKey", (account: unknown) => {
      const slot = lease(account);
      return run(slot, async () => {
        const next = await runDeviceKey("rotate", slot.directory);
        publicKeys.set(slot.directory, next);
        keylessRows.delete(slot.directory);
      });
    })
    .on("DeviceRegistry.setKeylessBridgeRowPk", async (account: unknown, rowId: unknown) => {
      const slot = lease(account);
      if (typeof rowId !== "string" || !(await rows(slot)).some(row => row.id === rowId && !row.public_key))
        throw new NativeRefusal("not_registered", "DeviceRegistry: keyless device not registered");
      keylessRows.set(slot.directory, rowId);
    });

  for (const op of ["signAttestationPreimage", "signForSessionHeader", "signCreateSessionBind", "signSessionBind",
    "signConversationBind", "signProjectThreadLink", "signTriggerOp", "signTriggerDigest", "signSessionRequest", "signSessionFileCopy"]) {
    host.on(`DeviceRegistry.${op}`, async (...args: unknown[]) => {
      try {
        const [account, request] = args;
        const slot = lease(account);
        return await run(slot, async () => {
          let context: Parameters<typeof encodeDeviceProof>[2] = { accountId: slot.owner };
          if (op !== "signAttestationPreimage") {
            const org = request && typeof request === "object" && "orgUuid" in request ? request.orgUuid : request;
            checkOrg(slot, org);
            const publicKey = await key(slot);
            const row = (await rows(slot)).find(value => value.public_key === publicKey);
            if (!row) throw new NativeRefusal("not_registered", "DeviceRegistry: device not registered for this account");
            context = { ...context, orgId: slot.orgId, rowPk: row.id, issuedAtMs: Date.now() };
          }
          const proof = encodeDeviceProof(op, args, context);
          if (!proof.ok) throw new NativeRefusal(proof.code, proof.message);
          await key(slot);
          return proof.formatResult(await runDeviceKey("sign", slot.directory, proof.preimage));
        });
      } catch (error) {
        if (op === "signTriggerDigest") {
          if (error instanceof DeviceKeyUnavailable) return { failure: { reason: "no_key" } };
          const code = error instanceof NativeRefusal ? error.code : "sign_error";
          if (code === "not_registered" || code === "bad_input") return { failure: { reason: code } };
          return { failure: { reason: "sign_failed", errorName: code } };
        }
        if (error instanceof DeviceKeyUnavailable)
          throw new NativeRefusal("no_key", "DeviceRegistry: hardware signing key is unavailable");
        throw error;
      }
    });
  }
  for (const op of ["notifyRegistered", "notifyBridgeAbsent", "noteRegistrationOutcome"])
    host.on(`DeviceRegistry.${op}`, (account: unknown) => { lease(account); });
}
