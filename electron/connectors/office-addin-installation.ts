import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export async function officeInstallation(root: string) {
  const directory = path.join(root, "office-addin");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, "localhost.key");
  const certPath = path.join(directory, "localhost.crt");
  const exists = await Promise.all(
    [keyPath, certPath].map((file) => fs.stat(file).catch(() => undefined)),
  );
  if (exists.some((file) => !file)) {
    const configPath = path.join(directory, "localhost.cnf");
    await fs.writeFile(
      configPath,
      "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=Claudex Office Add-in\n[v3]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n",
      { mode: 0o600 },
    );
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "365",
      "-config",
      configPath,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    await fs.chmod(keyPath, 0o600);
  }
  const configPath = path.join(directory, "bridge.json");
  const saved = await fs
    .readFile(configPath, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => ({}));
  const token =
    typeof saved.token === "string" && /^[a-f0-9]{64}$/.test(saved.token)
      ? saved.token
      : randomBytes(32).toString("hex");
  const port =
    Number.isInteger(saved.port) && saved.port > 1024 && saved.port <= 65535
      ? saved.port
      : undefined;
  return {
    key: await fs.readFile(keyPath, "utf8"),
    cert: await fs.readFile(certPath, "utf8"),
    token,
    port,
    certPath,
    save: (configuration: { token: string; port: number }) =>
      fs.writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 }),
  };
}
