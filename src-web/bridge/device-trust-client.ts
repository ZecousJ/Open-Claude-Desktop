import {
  trustedDeviceCall,
  type DeviceMethod,
  type DeviceTrustSigner,
} from "../../shared/remote-devices";

type KeyStore = (scope: string) => Promise<CryptoKeyPair>;
const cached = new Map<string, Promise<CryptoKeyPair>>();

/** IndexedDB stores a nonextractable private CryptoKey. No key is sent to
 * localStorage, a URL or the service; unavailable storage fails explicitly. */
async function browserKey(scope: string): Promise<CryptoKeyPair> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle)
    throw new Error("Device verification requires secure browser key storage.");
  let key = cached.get(scope);
  if (!key) {
    key = (async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("claudex-device-trust", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("keys");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const read = () =>
          new Promise<CryptoKeyPair | undefined>((resolve, reject) => {
            const transaction = db.transaction("keys", "readonly");
            const request = transaction.objectStore("keys").get(scope);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const saved = await read();
        if (saved) return saved;
        const made = (await crypto.subtle.generateKey(
          { name: "Ed25519" },
          false,
          ["sign", "verify"],
        )) as CryptoKeyPair;
        // Serialize the winner check and write across tabs; a concurrent tab
        // must never replace a key already approved on the host.
        return await new Promise<CryptoKeyPair>((resolve, reject) => {
          const transaction = db.transaction("keys", "readwrite");
          const store = transaction.objectStore("keys");
          const request = store.get(scope);
          let chosen = made;
          request.onsuccess = () => {
            if (request.result) chosen = request.result;
            else store.add(made, scope);
          };
          transaction.oncomplete = () => resolve(chosen);
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    })();
    cached.set(scope, key);
    void key.catch(() => cached.delete(scope));
  }
  return key;
}
const base64 = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));

export class BrowserDeviceTrustClient {
  private revoked = new Map<string, Set<string>>();
  scopeKey() {
    return this.scope();
  }
  isRevoked(device: string) {
    return this.revoked.get(this.scope() ?? "")?.has(device) ?? false;
  }
  constructor(
    private scope: () => string | undefined,
    private platform: string,
    private keys: KeyStore = browserKey,
  ) {}
  async call(
    raw: (method: DeviceMethod, args: unknown[]) => Promise<unknown>,
    device: string,
    method: DeviceMethod,
    args: unknown[],
  ) {
    const scope = this.scope();
    if (!scope) throw new Error("Sign in to Claudex again.");
    if (this.isRevoked(device))
      throw new Error("This device’s access was revoked.");
    const pair = await this.keys(scope);
    if (this.scope() !== scope)
      throw new Error("The signed-in account changed. Try again.");
    const publicBytes = await crypto.subtle.exportKey("spki", pair.publicKey);
    const signer: DeviceTrustSigner = {
      publicKey: `-----BEGIN PUBLIC KEY-----\n${base64(publicBytes)
        .match(/.{1,64}/g)!
        .join("\n")}\n-----END PUBLIC KEY-----\n`,
      name: "Web browser",
      platform: this.platform.slice(0, 40),
      sign: async (message) =>
        base64(
          await crypto.subtle.sign(
            "Ed25519",
            pair.privateKey,
            new TextEncoder().encode(message),
          ),
        ),
    };
    try {
      return await trustedDeviceCall(
        raw,
        signer,
        device,
        method,
        args,
        () => this.scope() === scope,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("access was revoked")
      ) {
        const revoked = this.revoked.get(scope) ?? new Set<string>();
        revoked.add(device);
        this.revoked.set(scope, revoked);
      }
      throw error;
    }
  }
}
