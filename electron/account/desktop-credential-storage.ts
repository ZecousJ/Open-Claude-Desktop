import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StorageCipher } from "../engine/provider-credentials";

const localFormat = Buffer.from("claudex-local-v1\0");
const nonceSize = 12;
const tagSize = 16;

export function desktopCredentialStorage(
  appRoot: string,
  platform: NodeJS.Platform,
  osCipher: StorageCipher,
) {
  if (platform !== "darwin")
    return { root: appRoot, cipher: osCipher, usesLocalFiles: false };

  const root = path.join(appRoot, "local-credentials");
  const keyFile = path.join(root, "storage.key");
  const hasLocalFormat = (value: Buffer) =>
    value.subarray(0, localFormat.length).equals(localFormat);
  const readKey = () => {
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw Error("Invalid local credential key.");
    return key;
  };
  function keyForWrite() {
    if (fs.existsSync(keyFile)) return readKey();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    const pending = `${keyFile}.${process.pid}.tmp`;
    fs.writeFileSync(pending, key, { mode: 0o600 });
    fs.renameSync(pending, keyFile);
    return key;
  }
  const cipher: StorageCipher = {
    isEncryptionAvailable: () => true,
    recognizes: hasLocalFormat,
    encryptString(value) {
      const nonce = randomBytes(nonceSize);
      const encryption = createCipheriv("aes-256-gcm", keyForWrite(), nonce);
      const ciphertext = Buffer.concat([
        encryption.update(value, "utf8"),
        encryption.final(),
      ]);
      return Buffer.concat([
        localFormat,
        nonce,
        encryption.getAuthTag(),
        ciphertext,
      ]);
    },
    decryptString(value) {
      const tagOffset = localFormat.length + nonceSize;
      const contentOffset = tagOffset + tagSize;
      if (!hasLocalFormat(value) || value.length < contentOffset)
        throw Error("Unsupported local credential format.");
      const decryption = createDecipheriv(
        "aes-256-gcm",
        readKey(),
        value.subarray(localFormat.length, tagOffset),
      );
      decryption.setAuthTag(value.subarray(tagOffset, contentOffset));
      return Buffer.concat([
        decryption.update(value.subarray(contentOffset)),
        decryption.final(),
      ]).toString("utf8");
    },
  };
  return { root, cipher, usesLocalFiles: true };
}
