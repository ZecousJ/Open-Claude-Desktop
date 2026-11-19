/** Authorized exact host-only readonly plan view. Original files never changed. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const hostUsageRevision = "claudex-readonly-usage-v1+zecous-transfer-v1";
export const hostUsageAssets = [
  ["assets/v1/claudex-host-usage.js", "scripts/official-host/usage-panel.mjs"],
  ["assets/v1/claudex-zecous-migration.js", "scripts/official-host/zecous-migration.mjs"],
];
export const hostUsageInputHashes = {
  "c71860c77-CWz32m5o.js":
    "3181f922d4445d8bdcd1e7d96e178f6f2b352e4e0e37a15d8c8f5ee5bf9b63f0",
  "cbbbe68ed-D7XDklrs.js":
    "bb5525e342dc66f5fa22b79eac3581ee8af1a24e61b748fc4d750901eaf6a87f",
  "shared-20-C2JgSgMH.js":
    "f7108f10707915a6f75800ddc2e3a899a23cc9890946d7d75a16f5183f42b3c0",
};
export const hostUsageOriginalHashes = {
  "c71860c77-CWz32m5o.js":
    "ee9a86bb67083cbabbfeb0250b59617799f3ffad21403f76b3caef0d3f77c290",
  "cbbbe68ed-D7XDklrs.js":
    "281659f313aed3949e3705cc9cf615515a47cf51398ddcbe17fef770596f2681",
  "shared-20-C2JgSgMH.js":
    "5079a46295b93a1bcb76333a1e52709e1c448f4ea744774b5c5655f22ab118e0",
};
const imported =
  'import {hasHostUsage as __claudexHasUsage, HostUsagePanel as __claudexUsagePanel} from "./claudex-host-usage.js";\n';
export const hostUsageRules = [
  {
    file: "c71860c77-CWz32m5o.js",
    name: "host-readonly-usage-pane",
    before: "function gs() {\n  return g(hs, {});\n}",
    after:
      'function gs() {\n  const {account,activeOrganization} = Ne();\n  return __claudexHasUsage(account,activeOrganization) ? g(__claudexUsagePanel,{account,organization:activeOrganization,view:"Usage"}) : g(hs, {});\n}',
  },
  {
    file: "cbbbe68ed-D7XDklrs.js",
    name: "host-readonly-billing-pane",
    before: "var Ng = e({ BillingPaneClient: () => zg, _test: () => Fg }),",
    after:
      'function __claudexBillingPane(props) {\n  const {account,activeOrganization,refetch} = Er();\n  return __claudexHasUsage(account,activeOrganization) ? b(__claudexUsagePanel,{account,organization:activeOrganization,view:"Billing",BillingRow:jp,refreshBootstrap:refetch},account.uuid) : b(zg,props);\n}\nvar Ng = e({ BillingPaneClient: () => __claudexBillingPane, _test: () => Fg }),',
  },
  {
    file: "shared-20-C2JgSgMH.js",
    name: "host-readonly-billing-nav",
    before: "    h = GmA(),\n    g = jj(),",
    after: "    h = GmA() || __claudexHasUsage(o,s),\n    g = jj(),",
  },
  {
    file: "shared-20-C2JgSgMH.js",
    name: "host-readonly-usage-nav",
    before: "    v = UF(i) || _,\n    y = MC(),",
    after: "    v = UF(i) || _ || __claudexHasUsage(o,s),\n    y = MC(),",
  },
];
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function deriveOfficialUiHostUsageModule(name, source) {
  if (!Object.hasOwn(hostUsageInputHashes, name)) return source;
  if (sha(source) !== hostUsageInputHashes[name])
    throw Error("Pinned host usage checksum mismatch: " + name);
  let next = source;
  for (const rule of hostUsageRules.filter((r) => r.file === name)) {
    const at = next.indexOf(rule.before);
    if (at < 0 || next.indexOf(rule.before, at + rule.before.length) !== -1)
      throw Error("Pinned host usage anchor mismatch: " + rule.name);
    next = next.slice(0, at) + rule.after + next.slice(at + rule.before.length);
  }
  return imported + next;
}
export function applyOfficialUiHostUsage(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const rows = Object.keys(hostUsageInputHashes).map((file) => {
    const full = path.join(directory, file);
    if (fs.lstatSync(full).isSymbolicLink())
      throw Error("Symlink output rejected");
    const input = fs.readFileSync(full, "utf8"),
      output = deriveOfficialUiHostUsageModule(file, input);
    return { file, input, output };
  });
  for (const r of rows)
    fs.writeFileSync(path.join(directory, r.file), r.output);
  return {
    revision: hostUsageRevision,
    modules: rows.map((r) => ({
      file: r.file,
      originalSha256: hostUsageOriginalHashes[r.file],
      inputSha256: sha(r.input),
      outputSha256: sha(r.output),
      rules: hostUsageRules.filter((x) => x.file === r.file).map((x) => x.name),
    })),
  };
}
