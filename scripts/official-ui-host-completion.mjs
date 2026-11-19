/** Derived Chat protocol compatibility only; no engine permission or vendor verification changes. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const hostCompletionRevision = "claudex-host-completion-v3";
export const hostCompletionSourceHashes = {
  "shared-4-Kt-jV-IU.js":
    "7ad8b1c516aac8a39f6c86f583f13c5926947941b2f69ea3d70877e50d8d9171",
  "c71860c77-DL-7pM_e.js":
    "bc897e4ff165f993f86a052d10edbb7646dc70e39291212b5f012563927bba41",
};
export const protocolPredicateSource =
  'function __claudexTextChatProtocol(state) {\n  const account = state?.account, org = state?.activeOrganization;\n  const descriptor = account?.claudex_frontend_completion_protocol;\n  return !!account && typeof account.uuid === "string" && account.uuid.length > 0 &&\n    !!org && typeof org.uuid === "string" && org.uuid.length > 0 && descriptor?.version === 1 && descriptor.account_uuid === account.uuid &&\n    descriptor.organization_uuid === org.uuid && descriptor.protocol === "text-chat-v1" &&\n    descriptor.surface === "chat" && descriptor.completion_path === "/chat_conversations/:id/completion" &&\n    descriptor.automatic_client_tools === "unsupported";\n}\nfunction __claudexKnownChatPath(pathname, state) {\n  return ((pathname === "/comparison" || pathname === "/comparison/") && state?.account?.claudex_comparison_supported === true) || pathname === "/new" || pathname === "/new/" || /^\\/chat\\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\/?$/i.test(pathname ?? "");\n}\n';
export const hostCompletionRules = [
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "subscribe-chat-path",
    before: "import { AQ,",
    after:
      'import { JN as __claudexChatPathname } from "./shared-l-p-m-w-1-O9prfPUL.js";\nimport { AQ,',
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "bind-initial-chat-protocol",
    before: "function bN(e) {\n  let t = CX(),",
    after: protocolPredicateSource +
      "function bN(e) {\n  const __host = a4(), __path = __claudexChatPathname(), __limited = __claudexTextChatProtocol(__host) && __claudexKnownChatPath(__path, __host), __explicitRepl = __host?.account?.settings?.enabled_artifacts_attachments === true;\n  let t = CX(),",
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "initial-automatic-artifact",
    before: '        s.push({ type: "artifacts_v0", name: "artifacts" }),',
    after:
      '        !__limited && s.push({ type: "artifacts_v0", name: "artifacts" }),',
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "initial-default-analysis",
    before:
      '        (e?.enabled_artifacts_attachments ?? !0) && s.push({ type: "repl_v0", name: "repl" }),',
    after:
      '        (!__limited || e?.enabled_artifacts_attachments === true || __explicitRepl) && (e?.enabled_artifacts_attachments ?? !0) && s.push({ type: "repl_v0", name: "repl" }),',
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "initial-static-widgets",
    before: "      for (let e of jQ)\n        (G9.has(e) && !g)",
    after:
      "      for (let e of (__limited ? [] : jQ))\n        (G9.has(e) && !g)",
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "initial-retain-dynamic",
    before:
      '        jQ.includes(e) || bB.includes(e) || (d && f.has(e)) || s.push({ type: "widget", name: e });',
    after:
      '        (!__limited && jQ.includes(e)) || bB.includes(e) || (d && f.has(e)) || s.push({ type: "widget", name: e });',
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "initial-hook-dependencies",
    before: "    [t, n, r, i, a, o, s, c, l, u, d, f, p, m, h],",
    after:
      "    [t, n, r, i, a, o, s, c, l, u, d, f, p, m, h, __limited, __explicitRepl],",
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "bind-existing-chat-protocol",
    before: "function HK(e, t, n) {\n  let { value: r } = YR(e ?? {}),",
    after:
      "function HK(e, t, n) {\n  const __host = a4(), __path = __claudexChatPathname(), __limited = __claudexTextChatProtocol(__host) && __claudexKnownChatPath(__path, __host), __explicitRepl = __host?.account?.settings?.enabled_artifacts_attachments === true;\n  let { value: r } = YR(e ?? {}),",
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "existing-automatic-artifact",
    before: '      t.push({ type: "artifacts_v0", name: "artifacts" }),',
    after:
      '      !__limited && t.push({ type: "artifacts_v0", name: "artifacts" }),',
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "existing-default-analysis",
    before: '      r && t.push({ type: "repl_v0", name: "repl" }),',
    after:
      '      (!__limited || e?.enabled_artifacts_attachments === true || __explicitRepl) && r && t.push({ type: "repl_v0", name: "repl" }),',
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "existing-static-widgets",
    before: "    for (let e of jQ)\n      (G9.has(e) && !n)",
    after: "    for (let e of (__limited ? [] : jQ))\n      (G9.has(e) && !n)",
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "existing-retain-dynamic",
    before:
      '      jQ.includes(e) || bB.includes(e) || (h && g.has(e)) || t.push({ type: "widget", name: e });',
    after:
      '      (!__limited && jQ.includes(e)) || bB.includes(e) || (h && g.has(e)) || t.push({ type: "widget", name: e });',
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "existing-hook-dependencies",
    before: "    S,\n    C,\n  ]);",
    after: "    S,\n    C,\n    __limited,\n    __explicitRepl,\n  ]);",
  },
  {
    file: "c71860c77-DL-7pM_e.js",
    name: "host-settings-predicate",
    before: "function ft() {\n  let $ = J9(13),",
    after:
      'function __claudexTextChatProtocol(state) {\n  const account = state?.account, org = state?.activeOrganization;\n  const descriptor = account?.claudex_frontend_completion_protocol;\n  return !!account && typeof account.uuid === "string" && account.uuid.length > 0 &&\n    !!org && typeof org.uuid === "string" && org.uuid.length > 0 && descriptor?.version === 1 && descriptor.account_uuid === account.uuid &&\n    descriptor.organization_uuid === org.uuid && descriptor.protocol === "text-chat-v1" &&\n    descriptor.surface === "chat" && descriptor.completion_path === "/chat_conversations/:id/completion" &&\n    descriptor.automatic_client_tools === "unsupported";\n}\nfunction ft() {\n  const __limited = __claudexTextChatProtocol(V());\n  let $ = J9(14),',
  },
  {
    file: "c71860c77-DL-7pM_e.js",
    name: "preserve-host-saved-settings",
    before: "          if (!c) return;",
    after: "          if (!c || __limited) return;",
  },
  {
    file: "c71860c77-DL-7pM_e.js",
    name: "settings-effect-dependencies",
    before: "        (f = [c, r, s]),",
    after: "        (f = [c, r, s, __limited]),",
  },
  {
    file: "c71860c77-DL-7pM_e.js",
    name: "refresh-settings-effect-capture",
    before: "    (J3($, 0, c, s, r)\n      ? ((l = () => {",
    after:
      "    ((J3($, 0, c, s, r) || $[13] !== __limited)\n      ? (($[13] = __limited), (l = () => {",
  },
  {
    file: "c71860c77-DL-7pM_e.js",
    name: "host-settings-control-state",
    before: "function mt(e) {\n  let $ = J9(40),",
    after:
      "function mt(e) {\n  const __limited = __claudexTextChatProtocol(V());\n  let $ = J9(40),",
  },
  {
    file: "c71860c77-DL-7pM_e.js",
    name: "host-settings-visible-readonly",
    before: "  return J3($, 36, S, T, y)\n    ? K3(",
    after:
      '  if (__limited && (t === "enabled_artifacts_attachments" || t === "preview_feature_uses_artifacts"))\n    return u("div", { className: "flex w-full flex-col", children: u(L, { label: y, description: S, control: u(x, { checked: C, disabled: true, "aria-labelledby": w }) }) });\n  return J3($, 36, S, T, y)\n    ? K3(',
  },

];
const hash = (source) => createHash("sha256").update(source).digest("hex");
export function deriveOfficialUiHostCompletionModule(name, source) {
  if (!Object.hasOwn(hostCompletionSourceHashes, name)) return source;
  if (hash(source) !== hostCompletionSourceHashes[name])
    throw Error(`Pinned host-completion source hash mismatch: ${name}`);
  let output = source;
  for (const rule of hostCompletionRules.filter((rule) => rule.file === name)) {
    const at = output.indexOf(rule.before);
    if (at < 0 || output.indexOf(rule.before, at + 1) !== -1)
      throw Error(
        `Pinned host-completion anchor mismatch: ${name}/${rule.name}`,
      );
    output =
      output.slice(0, at) + rule.after + output.slice(at + rule.before.length);
  }
  return output;
}
export function applyOfficialUiHostCompletion(assetsDir) {
  const directory = fs.realpathSync(assetsDir);
  const sourceRoots = [process.env.CLAUDEX_OFFICIAL_EXTRACTED, process.env.CLAUDEX_OFFICIAL_UI_SOURCE]
    .filter((root) => root && fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  if (directory.split(path.sep).includes(".restore") ||
      sourceRoots.some((root) => directory === root || directory.startsWith(root + path.sep)))
    throw Error("Recovered official sources are immutable.");
  // Prepare and validate the full set before the first write.
  const prepared = Object.keys(hostCompletionSourceHashes).map((file) => {
    const location = path.join(directory, file);
    if (fs.lstatSync(location).isSymbolicLink())
      throw Error("Host-auth derived output cannot be a symlink.");
    const source = fs.readFileSync(location, "utf8");
    return {
      file,
      source,
      output: deriveOfficialUiHostCompletionModule(file, source),
    };
  });
  for (const item of prepared)
    fs.writeFileSync(path.join(directory, item.file), item.output);
  return {
    revision: hostCompletionRevision,
    modules: prepared.map((item) => ({
      file: item.file,
      originalSha256: hash(item.source),
      outputSha256: hash(item.output),
      rules: hostCompletionRules
        .filter((rule) => rule.file === item.file)
        .map((rule) => rule.name),
    })),
  };
}
