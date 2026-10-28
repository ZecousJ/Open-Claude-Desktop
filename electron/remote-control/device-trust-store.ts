import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  deviceTrustMessage,
  type DeviceTrustChallenge,
  type DeviceTrustClient,
  type DeviceTrustEnvelope,
  type DeviceTrustState,
} from "../../shared/remote-devices";

type Client = DeviceTrustClient & { publicKey: string; revokedAt?: string };
type Saved = {
  version: 1;
  accountScope: string;
  requireTrustedDevices: boolean;
  deviceId: string;
  clients: Client[];
};
type Challenge = { value: DeviceTrustChallenge; client: Client };
const lifetime = 120_000;
const maxChallenges = 128;
const maxClients = 128;
const deny = () => {
  throw new Error("Verify this device on your computer before connecting.");
};
const iso = (now: number) => new Date(now).toISOString();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Account-scoped local trust authority. Only the window's authenticated IPC
 * may call approve/revoke/setRequired. Remote enrollment merely queues a key
 * whose possession was proven; it never approves its own trust. */
export class DeviceTrustStore {
  private revision = 0;
  get accessRevision() {
    return this.revision;
  }
  private saved: Saved;
  private challenges = new Map<string, Challenge>();
  private pending = new Map<string, Client>();
  private readonly file: string;

  constructor(
    directory: string,
    readonly accountScope: string,
    readonly deviceId: string,
    private now: () => number = Date.now,
    private changed: () => void = () => {},
  ) {
    if (!accountScope || !deviceId)
      throw new Error("A signed-in device account is required.");
    this.file = path.join(
      directory,
      `device-access-${digest(accountScope)}.json`,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let saved: Saved | undefined;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Saved;
      if (
        saved.version !== 1 ||
        saved.accountScope !== accountScope ||
        typeof saved.requireTrustedDevices !== "boolean" ||
        !Array.isArray(saved.clients) ||
        saved.clients.length > maxClients ||
        typeof saved.deviceId !== "string" ||
        !saved.clients.every((client) => this.validSavedClient(client))
      )
        throw new Error("Invalid saved device access policy.");
      // A renewed link id: the policy carries over, the trusted devices do not
      // (they verified the old id), so each one is approved again rather than
      // every call failing.
      if (saved.deviceId !== deviceId)
        saved = { ...saved, deviceId, clients: [] };
    } catch (error) {
      // Missing is the only safe initial state. Corruption or read failures
      // cannot silently turn an existing trust policy off.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.saved = saved ?? {
      version: 1,
      accountScope,
      requireTrustedDevices: false,
      deviceId,
      clients: [],
    };
    this.commit(this.saved);
  }

  private validSavedClient(client: Client) {
    try {
      const normalized = this.client({
        publicKey: client.publicKey,
        name: client.name,
        platform: client.platform,
      });
      return (
        client.id === normalized.id &&
        client.fingerprint === normalized.fingerprint &&
        Number.isFinite(Date.parse(client.addedAt)) &&
        (!client.revokedAt || Number.isFinite(Date.parse(client.revokedAt)))
      );
    } catch {
      return false;
    }
  }

  private commit(next: Saved) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.saved = next;
  }

  private public(client: Client): DeviceTrustClient {
    const { publicKey: _key, revokedAt: _revoked, ...value } = client;
    return { ...value };
  }

  state(): DeviceTrustState {
    return {
      requireTrustedDevices: this.saved.requireTrustedDevices,
      trusted: this.saved.clients
        .filter((client) => !client.revokedAt)
        .map((client) => this.public(client)),
      pending: [...this.pending.values()].map((client) => this.public(client)),
    };
  }

  /** A verified relay call from Settings on the web (deviceTrustRemoteMethods). */
  remote(method: string, args: unknown[]): DeviceTrustState {
    if (method === "deviceTrustRequire") {
      if (args[0] !== true)
        throw new Error(
          "Turn off Require trusted devices on the computer itself.",
        );
      this.setRequired(true);
    } else if (method === "deviceTrustRevoke") {
      if (typeof args[0] !== "string")
        throw new Error("Invalid device access request.");
      this.revoke(args[0]);
    } else if (method !== "deviceTrustSummary")
      throw new Error("Invalid device access request.");
    // Approvals are the computer's: the web isn't told who waits.
    return { ...this.state(), pending: [] };
  }

  setRequired(required: boolean) {
    if (typeof required !== "boolean")
      throw new Error("Invalid device access policy.");
    this.commit({ ...this.saved, requireTrustedDevices: required });
    this.revision++;
    this.changed();
    return this.state();
  }

  approve(id: string, fingerprint: string) {
    const client = this.pending.get(id);
    if (!client || client.fingerprint !== fingerprint)
      throw new Error("This verification request has expired.");
    if (
      !this.saved.clients.some((item) => item.id === id) &&
      this.saved.clients.length >= maxClients
    )
      throw new Error("The device registration limit has been reached.");
    const approved = {
      ...client,
      addedAt: iso(this.now()),
      revokedAt: undefined,
    };
    this.commit({
      ...this.saved,
      clients: [
        ...this.saved.clients.filter((item) => item.id !== id),
        approved,
      ],
    });
    this.pending.delete(id);
    this.changed();
    return this.state();
  }

  reject(id: string) {
    this.pending.delete(id);
    this.changed();
    return this.state();
  }

  revoke(id: string) {
    if (!this.saved.clients.some((item) => item.id === id && !item.revokedAt))
      throw new Error("This trusted device no longer exists.");
    this.commit({
      ...this.saved,
      clients: this.saved.clients.map((client) =>
        client.id === id ? { ...client, revokedAt: iso(this.now()) } : client,
      ),
    });
    this.pending.delete(id);
    this.revision++;
    for (const [key, challenge] of this.challenges)
      if (challenge.client.id === id) this.challenges.delete(key);
    this.changed();
    return this.state();
  }

  private client(input: unknown): Client {
    if (!input || typeof input !== "object") return deny();
    const value = input as Record<string, unknown>;
    if (
      typeof value.publicKey !== "string" ||
      value.publicKey.length > 512 ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 80 ||
      typeof value.platform !== "string" ||
      value.platform.length > 40
    )
      return deny();
    const key = createPublicKey(value.publicKey);
    if (key.asymmetricKeyType !== "ed25519") return deny();
    const publicKey = key.export({ type: "spki", format: "pem" }).toString();
    const id = digest(publicKey);
    return {
      id,
      publicKey,
      fingerprint: id.match(/.{1,4}/g)!.join(" "),
      name: value.name.trim(),
      platform: value.platform,
      addedAt: iso(this.now()),
    };
  }

  challenge(input: unknown): DeviceTrustChallenge {
    const client = this.client(input);
    for (const [id, challenge] of this.challenges)
      if (challenge.value.expiresAt <= this.now()) this.challenges.delete(id);
    if (this.challenges.size >= maxChallenges)
      throw new Error("Too many verification attempts. Try again shortly.");
    if (
      this.saved.clients.some((item) => item.id === client.id && item.revokedAt)
    )
      throw new Error("This device’s access was revoked.");
    const value: DeviceTrustChallenge = {
      id: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      accountScope: this.accountScope,
      deviceId: this.deviceId,
      requireTrustedDevices: this.saved.requireTrustedDevices,
      expiresAt: this.now() + lifetime,
    };
    this.challenges.set(value.id, { value, client });
    return { ...value };
  }

  private proof(method: string, envelope: DeviceTrustEnvelope) {
    const proof = envelope?.deviceTrust;
    if (
      !proof ||
      typeof proof.challengeId !== "string" ||
      typeof proof.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature) ||
      !Array.isArray(envelope.args)
    )
      return deny();
    const challenge = this.challenges.get(proof.challengeId);
    this.challenges.delete(proof.challengeId);
    if (
      !challenge ||
      challenge.value.expiresAt <= this.now() ||
      !verify(
        null,
        Buffer.from(deviceTrustMessage(challenge.value, method, envelope.args)),
        challenge.client.publicKey,
        Buffer.from(proof.signature, "base64"),
      )
    )
      return deny();
    if (
      this.saved.clients.some(
        (item) => item.id === challenge.client.id && item.revokedAt,
      )
    )
      return deny();
    return challenge.client;
  }

  enroll(envelope: DeviceTrustEnvelope) {
    if (envelope?.args?.length !== 0) return deny();
    const client = this.proof("deviceTrustEnroll", envelope);
    const approved = this.saved.clients.find(
      (item) => item.id === client.id && !item.revokedAt,
    );
    if (approved)
      return { status: "trusted" as const, fingerprint: approved.fingerprint };
    if (!this.pending.has(client.id) && this.pending.size >= 32)
      throw new Error("Too many pending device requests.");
    this.pending.set(client.id, client);
    this.changed();
    return { status: "pending" as const, fingerprint: client.fingerprint };
  }

  /** All real relay calls pass here before DeviceMethods, including Code,
   * Cowork and Chat. The optional legacy path exists only when policy is off. */
  authorize(method: string, args: unknown[]): unknown[] {
    const envelope =
      args.length === 1 &&
      args[0] &&
      typeof args[0] === "object" &&
      "deviceTrust" in args[0]
        ? (args[0] as DeviceTrustEnvelope)
        : undefined;
    if (!envelope) {
      if (this.saved.requireTrustedDevices) return deny();
      return args;
    }
    const client = this.proof(method, envelope);
    if (
      this.saved.requireTrustedDevices &&
      !this.saved.clients.some(
        (item) => item.id === client.id && !item.revokedAt,
      )
    )
      return deny();
    const at = iso(this.now());
    this.commit({
      ...this.saved,
      clients: this.saved.clients.map((item) =>
        item.id === client.id ? { ...item, lastSeenAt: at } : item,
      ),
    });
    return envelope.args;
  }
}
