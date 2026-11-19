import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const file = "shared-l-p-m-w-5-BDZb5dJN.js";
export const hostUserContentRevision = "claudex-usercontent-origin-v2";
export const hostUserContentHashes = {
  [file]: "2c70fd09fd96d0898776ebda7cec08b47ff15ec1035c3fdd5ea17a34631b2351",
};
export const hostUserContentRules = [
  {
    file,
    name: "host-owned-usercontent-origin",
    before: '    userContentRendererUrl: "https://www.claudeusercontent.com",',
    after: '    userContentRendererUrl: globalThis.__claudexOfficialUserContentOrigin ?? "https://www.claudeusercontent.com",',
  },
  {
    file,
    name: "host-owned-mcp-app-sandbox-url",
    before: '    mcpAppsSandboxProxyUrl: "https://sandbox.claudemcpcontent.com/mcp_apps",',
    after: '    mcpAppsSandboxProxyUrl: globalThis.__claudexMcpAppsSandboxUrl ?? "https://sandbox.claudemcpcontent.com/mcp_apps",',
  },
];
const hash = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiUserContent(name, source) {
  if (!Object.hasOwn(hostUserContentHashes, name)) return source;
  if (hash(source) !== hostUserContentHashes[name]) throw Error("Pinned user-content source hash mismatch");
  for (const rule of hostUserContentRules) {
    if (rule.file !== name) continue;
    if (source.split(rule.before).length !== 2) throw Error("Pinned user-content anchor mismatch");
    source = source.replace(rule.before, rule.after);
  }
  return source;
}

export function applyOfficialUiUserContent(directory) {
  const real = fs.realpathSync(directory);
  if (real.split(path.sep).includes(".restore")) throw Error("Recovered sources are immutable");
  const target = path.join(real, file);
  if (fs.lstatSync(target).isSymbolicLink()) throw Error("Symlink output rejected");
  const source = fs.readFileSync(target, "utf8");
  const output = deriveOfficialUiUserContent(file, source);
  fs.writeFileSync(target, output);
  return {
    revision: hostUserContentRevision,
    modules: [{
      file,
      originalSha256: hash(source),
      outputSha256: hash(output),
      rules: hostUserContentRules.map((rule) => rule.name),
    }],
  };
}
