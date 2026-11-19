/** Narrow host-specific routing integration. Never changes vendor verification facts or backend authorization. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const hostAuthRevision = "claudex-host-auth-routing-v2";
export const hostAuthSourceHashes = {
  "shared-m-1-Nm0kn4Ee.js":
    "885e84da6a4a4c2e10be0081d2e75e6479cb774d0c74a945c98c2ccf26741381",
  "shared-20-C2JgSgMH.js":
    "5079a46295b93a1bcb76333a1e52709e1c448f4ea744774b5c5655f22ab118e0",
  "c3e61dd2f-CV4o0SF2.js":
    "fee2bf945876bbbf59e72ee86747673a0f2fa5059b0a8bd749770d1658c81ad4",
  "shared-l-p-m-w-1-O9prfPUL.js":
    "ddb153a48a3a24764566d8ecb358da29f3aa1b4dcd7750d8070070e31477cb5c",
  "shared-l-p-m-w-2-BMCa56Vr.js":
    "a1f9dc95699474a630edb26b86b33f499c82f8f43fc92b1820048bcb21e91879",
  "shared-l-p-m-w-4-BkeeGGW7.js":
    "2612298503bc9739579363949605b753ca8f8a71f1c6af7373c0fcf1f1646da9",
  "cf6c0e3a1-Y4ypZkpd.js":
    "fad7ca0845dd68c0240e1179f6d8bc79bb811cd6b7a57c28e68d8a17595114f7",
};
// Marker describes an existing Claudex host session, NOT age/email/identity proof.
export const hostAuthenticatedExpression =
  '!!e && typeof e.uuid === "string" && e.uuid.length > 0 && e.claudex_host_authentication?.version === 1 && e.claudex_host_authentication?.status === "authenticated" && e.claudex_host_authentication?.account_uuid === e.uuid';
const boundHost = (account) =>
  hostAuthenticatedExpression.replace(/\be\b/g, account);
export const hostAuthRules = [
  {
    file: "shared-m-1-Nm0kn4Ee.js",
    name: "host-authenticated-history-page-read",
    before: "    v = !!u && !!l?.is_verified && c && d.isAvailable,",
    after: `    v = !!u && (!!l?.is_verified || (${boundHost("l")})) && c && d.isAvailable,`,
  },
  {
    file: "shared-m-1-Nm0kn4Ee.js",
    name: "host-authenticated-history-infinite-read",
    before: "    w = !!m && !!p?.is_verified && d && h.isAvailable,",
    after: `    w = !!m && (!!p?.is_verified || (${boundHost("p")})) && d && h.isAvailable,`,
  },
  {
    file: "shared-20-C2JgSgMH.js",
    name: "host-authenticated-recents-live-read",
    before:
      '    g = t && !!s && !!o?.is_verified && c.isAvailable && (n === "live" || h),',
    after: `    g = t && !!s && (!!o?.is_verified || (${boundHost("o")})) && c.isAvailable && (n === "live" || h),`,
  },
  {
    file: "c3e61dd2f-CV4o0SF2.js",
    name: "host-authenticated-transcript-freshness-read",
    before:
      "    D = x.enabled && r && n !== void 0 && E !== void 0 && w?.is_verified === !0,",
    after: `    D = x.enabled && r && n !== void 0 && E !== void 0 && (w?.is_verified === !0 || (${boundHost("w")})),`,
  },

  {
    file: "shared-l-p-m-w-1-O9prfPUL.js",
    name: "carry-independent-host-auth-routing-state",
    before: "function vM(e) {\n  return {\n    get is_verified() {",
    after: `function vM(e) {\n  return {\n    get hostAuthenticated() {\n      return ${hostAuthenticatedExpression};\n    },\n    get is_verified() {`,
  },
  {
    file: "shared-l-p-m-w-1-O9prfPUL.js",
    name: "route-host-session-without-claiming-vendor-verification",
    before:
      'function DL(e) {\n  if (!e.is_verified) return "identity_verification";\n  if (!e.has_membership) return "organization_membership";\n  if (!e.onboarding_complete) return "onboarding";\n  if (!e.age_verified) return "age_verification";\n  if (e.pending_invite) return "pending_invites";\n}',
    after:
      'function DL(e) {\n  if (!e.hostAuthenticated && !e.is_verified) return "identity_verification";\n  if (!e.has_membership) return "organization_membership";\n  if (!e.onboarding_complete) return "onboarding";\n  if (!e.hostAuthenticated && !e.age_verified) return "age_verification";\n  if (e.pending_invite) return "pending_invites";\n}',
  },
  {
    file: "shared-l-p-m-w-2-BMCa56Vr.js",
    name: "scope-identity-route-to-vendor-host",
    before: "function dF(e, t) {\n  return t && jo(e);\n}",
    after: `function dF(e, t) {\n  return t && !(${hostAuthenticatedExpression}) && jo(e);\n}`,
  },
  {
    file: "shared-l-p-m-w-2-BMCa56Vr.js",
    name: "scope-age-route-to-vendor-host",
    before: "function c3(e, t, n = !1) {\n  return n && t && g7(e);\n}",
    after: `function c3(e, t, n = !1) {\n  return n && t && !(${hostAuthenticatedExpression}) && g7(e);\n}`,
  },
  {
    file: "shared-l-p-m-w-4-BkeeGGW7.js",
    name: "preserve-host-auth-in-direct-post-login-route",
    before: "    if (t && !t.is_verified) return Zy.identity_verification;",
    after:
      "    if (t && !t.hostAuthenticated && !t.is_verified) return Zy.identity_verification;",
  },
  {
    file: "cf6c0e3a1-Y4ypZkpd.js",
    name: "open-comparison-for-supported-host",
    before: 'function Ui() {\n  let $ = J9(2);\n  return F("__gb__2366236732")',
    after: `function Ui() {
  let $ = J9(2);
  const vendorCompare = F("__gb__2366236732");
  const { account } = ke();
  return vendorCompare || (account?.claudex_comparison_supported === true && (${boundHost("account")}))
`.trimEnd(),
  },
];
const hash = (source) => createHash("sha256").update(source).digest("hex");
export function deriveOfficialUiHostAuthModule(name, source) {
  if (!Object.hasOwn(hostAuthSourceHashes, name)) return source;
  if (hash(source) !== hostAuthSourceHashes[name])
    throw Error(`Pinned host-auth source hash mismatch: ${name}`);
  let output = source;
  for (const rule of hostAuthRules.filter((rule) => rule.file === name)) {
    const at = output.indexOf(rule.before);
    if (at < 0 || output.indexOf(rule.before, at + 1) !== -1)
      throw Error(`Pinned host-auth anchor mismatch: ${name}/${rule.name}`);
    output =
      output.slice(0, at) + rule.after + output.slice(at + rule.before.length);
  }
  return output;
}
export function applyOfficialUiHostAuth(assetsDir) {
  const directory = fs.realpathSync(assetsDir);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered official sources are immutable.");
  // Prepare and validate the full set before the first write.
  const prepared = Object.keys(hostAuthSourceHashes).map((file) => {
    const location = path.join(directory, file);
    if (fs.lstatSync(location).isSymbolicLink())
      throw Error("Host-auth derived output cannot be a symlink.");
    const source = fs.readFileSync(location, "utf8");
    return {
      file,
      source,
      output: deriveOfficialUiHostAuthModule(file, source),
    };
  });
  for (const item of prepared)
    fs.writeFileSync(path.join(directory, item.file), item.output);
  return {
    revision: hostAuthRevision,
    modules: prepared.map((item) => ({
      file: item.file,
      originalSha256: hash(item.source),
      outputSha256: hash(item.output),
      rules: hostAuthRules
        .filter((rule) => rule.file === item.file)
        .map((rule) => rule.name),
    })),
  };
}
