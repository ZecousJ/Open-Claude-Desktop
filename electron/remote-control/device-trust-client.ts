import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  trustedDeviceCall,
  type DeviceMethod,
  type DeviceTrustSigner,
} from "../../shared/remote-devices";

/** Private client key is account/service scoped and never sent to the relay. */
export class DesktopDeviceTrustClient {
  private revoked = new Set<string>();
  private activeScope?: string;
  constructor(
    private directory: () => string,
    private scope: () => string | undefined,
    private name: () => string,
    private platform = process.platform,
  ) {}

  private signer(scope: string): DeviceTrustSigner {
    const directory = this.directory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(
      directory,
      `device-client-${createHash("sha256").update(scope).digest("hex")}.pem`,
    );
    let key: string;
    try {
      key = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const pair = generateKeyPairSync("ed25519");
      key = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      try {
        fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
          throw writeError;
        key = fs.readFileSync(file, "utf8");
      }
    }
    const privateKey = createPrivateKey(key);
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("Invalid device client key.");
    return {
      publicKey: createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString(),
      name: this.name(),
      platform: this.platform,
      sign: async (message) =>
        sign(null, Buffer.from(message), privateKey).toString("base64"),
    };
  }
  async call(
    raw: (method: DeviceMethod, args: unknown[]) => Promise<unknown>,
    device: string,
    method: DeviceMethod,
    args: unknown[],
  ) {
    const scope = this.scope();
    if (!scope) throw new Error("Sign in to Claudex again.");
    if (this.activeScope !== scope) {
      this.revoked.clear();
      this.activeScope = scope;
    }
    if (this.revoked.has(device))
      throw new Error("This device’s access was revoked.");
    try {
      return await trustedDeviceCall(
        raw,
        this.signer(scope),
        device,
        method,
        args,
        () => this.scope() === scope,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("access was revoked")
      )
        this.revoked.add(device);
      throw error;
    }
  }
}
