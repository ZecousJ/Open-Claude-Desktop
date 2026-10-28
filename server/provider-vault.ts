import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface Envelope {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
}
function validEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 1 &&
    typeof item.nonce === "string" &&
    /^[a-f0-9]{24}$/.test(item.nonce) &&
    typeof item.tag === "string" &&
    /^[a-f0-9]{32}$/.test(item.tag) &&
    typeof item.ciphertext === "string" &&
    item.ciphertext.length <= 10_000_000
  );
}
function validKeys(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).length <= 30 &&
    Object.entries(value).every(
      ([id, key]) =>
        id.length > 0 &&
        id.length <= 100 &&
        typeof key === "string" &&
        key.length <= 16000,
    )
  );
}

/** Provider secrets are encrypted and persisted only inside the backend profile. */
export class ProviderVault {
  private readonly filename: string;
  private readonly master: Buffer;
  private keys: Record<string, string> = {};
  constructor(root: string, masterHex: string) {
    if (!/^[a-f0-9]{64}$/.test(masterHex))
      throw Error("Invalid provider vault key.");
    this.master = Buffer.from(masterHex, "hex");
    const folder = path.join(root, "backend");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.filename = path.join(folder, "provider-keys.enc");
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.filename, "utf8"),
      );
      if (!validEnvelope(parsed))
        throw Error("Invalid encrypted provider store.");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.master,
        Buffer.from(parsed.nonce, "hex"),
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));
      const content = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const keys: unknown = JSON.parse(content);
      if (!validKeys(keys)) throw Error("Invalid provider key data.");
      this.keys = keys;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error(
          "Provider key store cannot be decrypted; it has not been overwritten.",
        );
    }
  }
  private save(next: Record<string, string>) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.master, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(next), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      nonce: nonce.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
    this.keys = next;
  }
  get(id: string) {
    return this.keys[id] ?? "";
  }
  status(ids: string[]) {
    return Object.fromEntries(ids.map((id) => [id, Boolean(this.keys[id])]));
  }
  setMany(patch: Record<string, string>, allowedIds: string[]) {
    if (
      !validKeys(patch) ||
      allowedIds.length > 30 ||
      allowedIds.some((id) => typeof id !== "string" || id.length > 100)
    )
      throw Error("Invalid provider key update.");
    const allowed = new Set(allowedIds),
      next: Record<string, string> = {};
    for (const [id, key] of Object.entries(this.keys))
      if (allowed.has(id)) next[id] = key;
    for (const [id, key] of Object.entries(patch))
      if (allowed.has(id)) next[id] = key.trim();
    this.save(next);
    return this.status(allowedIds);
  }
}
