/** Operator-only localhost setup. Reads the upstream key from stdin, never from argv. */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const root = option("--data-dir"),
  baseUrl = option("--base-url"),
  model = option("--model"),
  protocol = option("--protocol") ?? "responses",
  transcriptionModel = option("--transcription-model");
if (
  !root ||
  !baseUrl ||
  !model ||
  !["responses", "chat"].includes(protocol) ||
  !process.argv.includes("--key-stdin") ||
  (transcriptionModel && transcriptionModel.length > 200)
)
  throw Error(
    "Usage: node scripts/configure-backend.mjs --data-dir DIR --base-url URL --model MODEL --protocol responses|chat [--transcription-model MODEL] --key-stdin",
  );
const url = new URL(baseUrl);
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
  throw Error("Invalid upstream URL.");
const input = createInterface({ input: process.stdin, terminal: false });
const apiKey = await new Promise((resolve, reject) => {
  let received = false;
  input.once("line", (line) => {
    received = true;
    resolve(line.trim());
    input.close();
  });
  input.once("close", () => {
    if (!received) reject(Error("No upstream key was supplied."));
  });
});
if (!apiKey || apiKey.length > 16000)
  throw Error("Upstream key must be supplied on stdin.");
const backend = path.join(path.resolve(root), "backend");
fs.mkdirSync(backend, { recursive: true, mode: 0o700 });
if (
  !process.argv.includes("--replace") &&
  ["operator.json", "bootstrap-secret.json"].some((name) =>
    fs.existsSync(path.join(backend, name)),
  )
)
  throw Error(
    "Backend configuration already exists; use --replace only when intentionally changing it.",
  );
const provider = {
  id: "managed",
  name: "Claudex",
  baseUrl: url.toString(),
  protocol,
  model,
  models: [model],
  ...(transcriptionModel ? { transcriptionModel } : {}),
};
for (const [name, value] of [
  [
    "operator.json",
    JSON.stringify(
      { version: 1, providers: [provider], activeProviderId: "managed" },
      null,
      2,
    ),
  ],
  ["bootstrap-secret.json", JSON.stringify({ providerId: "managed", apiKey })],
]) {
  const filename = path.join(backend, name),
    temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
console.log(
  "Local backend configuration saved. The bootstrap secret will be imported and removed by the provider service at next sign-in.",
);
