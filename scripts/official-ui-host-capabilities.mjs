/**
 * Explicit, pinned host capability adaptation. This is NOT a permission grant.
 * Permission/ownership changes require a marker emitted by Claudex's readonly
 * adapter. Unmarked upstream objects retain their existing ownership/policy.
 * Call only from the authorized assembly pipeline, never on recovered sources.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const hostCapabilityRevision = "claudex-skill-capabilities-v10";
// Pinned 79979f1379 bytes AFTER the pinned host-auth routing and existing branding stages.
export const hostCapabilityInputHashes = {
  "cc20c35ef-BByxoJKF.js":
    "b3794b403994cc7b142e9e03d49a0098dc79f79365235fd247f331c6a27fbd3d",
  "c2e144342-BPmQtTD1.js":
    "5e4f586b5dd369c786c9287e09c5c0c3980cf3563d31ce53405d4b1c8107b730",
  "c24c8737b-5PJBZo1Q.js":
    "0368f6b1a861daa460515ab62a8614a05c7e0e148bfdd7a310ff05c2b61d7424",
  "c6a2a31c4-Ctc4FG8F.js":
    "d12e06609081c764be2f9438d0c8fdf0ff1828cfb294786033ac05fa086734a5",
  "shared-m-1-Nm0kn4Ee.js":
    "2f552ce5af00d078b18d31c1896e08958b4066aa04719fbe5b84e97ef10c196f",
  "c8cba5cdc-B45Vl3wA.js":
    "94864315dc56eb308a3d3318ccedbf1e6a48b74364ea674274ecf4371f92de42",
  "ccea1f474-B2jbjvXx.js":
    "d6ddc0167e8eac9793c51465495e21c74c4117f4a4e776621cf7d290825363aa",
  "cc183b3ab-Dq3NZ8k1.js":
    "fdba8029f97332e86837306e8488691c81859430cfaaa9b0618f113dac14730e",
};
export const hostCapabilityOriginalHashes = {
  "cc20c35ef-BByxoJKF.js":
    "b1642ec2767522074e386057717db6b9acedc14abe2c7a3028c4c662ac22f586",
  "c2e144342-BPmQtTD1.js":
    "5e4f586b5dd369c786c9287e09c5c0c3980cf3563d31ce53405d4b1c8107b730",
  "c24c8737b-5PJBZo1Q.js":
    "616b2660e134883e7adb831608c37532ae1db914a7ca06e800072033d907c2d2",
  "c6a2a31c4-Ctc4FG8F.js":
    "5e13d857dfdf2214034d4077f4e8334fd6b260d4ce2ac76a16ae2d126b182b7b",
  "shared-m-1-Nm0kn4Ee.js":
    "885e84da6a4a4c2e10be0081d2e75e6479cb774d0c74a945c98c2ccf26741381",
  "c8cba5cdc-B45Vl3wA.js":
    "94864315dc56eb308a3d3318ccedbf1e6a48b74364ea674274ecf4371f92de42",
  "ccea1f474-B2jbjvXx.js":
    "8f971a8e3a2626bd4fe79330ecdb6850f116a087ff41d759304b745b002019ed",
  "cc183b3ab-Dq3NZ8k1.js":
    "351e8f57cc3f7af63e0cef823aed5836e235183f78d856fa3d693ad3b36e528a",
};
const digest = (text) => createHash("sha256").update(text).digest("hex");

export const hostCapabilityRules = [
  {
    file: "cc20c35ef-BByxoJKF.js",
    name: "open-claudex-chrome-setup-from-install-hub",
    before: `          n
            ? {
                label: e.formatMessage({ defaultMessage: "Install", id: "ubmFc8" }),
                href: "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn",
              }
            : {
                label: e.formatMessage({ defaultMessage: "Upgrade", id: "0h/lPMeYkq" }),
                href: "/upgrade?from=install_hub",
                isExternal: !1,
              },`,
    after: `          {
            label: e.formatMessage({ defaultMessage: "Install", id: "ubmFc8" }),
            href: "/settings/desktop",
            isExternal: !1,
          },`,
  },
  {
    file: "cc20c35ef-BByxoJKF.js",
    name: "omit-unavailable-terminal-illustration",
    before: `children: d(vt, {
              src: "/images/CLI.png",
              alt: "Claude Code CLI",
              width: 320,
              height: 80,
              className: "w-auto h-auto",
              priority: !0,
            })`,
    after: "children: null",
  },
  {
    file: "ccea1f474-B2jbjvXx.js",
    name: "preserve-neutral-readonly-control-reason",
    before: "function _s(e) {\n  switch (e) {",
    after:
      'function _s(e) {\n  switch (e) {\n    case "host_read_only":\n      return "other";',
  },
  {
    file: "c2e144342-BPmQtTD1.js",
    name: "preserve-skill-host-capabilities",
    before: "    canEdit: e.viewer.installed?.can_edit ?? void 0,",
    after: `    claudexReadOnly: e.viewer.installed?.claudex_read_only === true,
    claudexCanEditContents: e.viewer.installed?.claudex_can_edit_contents === true,
    canEdit: e.viewer.installed?.can_edit ?? void 0,`,
  },
  {
    file: "c24c8737b-5PJBZo1Q.js",
    name: "enable-original-skill-contents-editor",
    before: "      ? K4($, 23, m, Ee, J, De, !!J && De && Ee && (m ? _e(J) && J.backingPluginId === m : ve(J)))",
    after: `      ? K4($, 23, m, Ee, J, De, !!J && (
          (!m && J.claudexCanEditContents === true) ||
          (De && Ee && (m ? _e(J) && J.backingPluginId === m : ve(J)))
        ))`,
  },
  {
    file: "c6a2a31c4-Ctc4FG8F.js",
    name: "separate-skill-ownership-from-edit-capability",
    before:
      'function Sm(e) {\n  return Ye(e) || Ke(e) ? "you" : e.creatorType === "anthropic" ? "anthropic" : "org";\n}',
    after:
      'function Sm(e) {\n  if (e.claudexReadOnly === true && e.source === "custom" && e.creatorType === "user" && e.partitionBy === "account" && !e.isShared) return "you";\n  return Ye(e) || Ke(e) ? "you" : e.creatorType === "anthropic" ? "anthropic" : "org";\n}',
  },
  {
    file: "shared-m-1-Nm0kn4Ee.js",
    name: "explain-personal-skill-host-readonly-without-fake-org-policy",
    before:
      'function wD(e) {\n  let t = e.source === "plugin" && !e.backingPluginId;',
    after:
      'function wD(e) {\n  if (e.claudexReadOnly === true && e.source === "custom" && e.creatorType === "user" && e.partitionBy === "account" && !e.isShared && e.backingPluginRequired !== true && e.canRemove === false) return "host_read_only";\n  let t = e.source === "plugin" && !e.backingPluginId;',
  },
  {
    file: "c8cba5cdc-B45Vl3wA.js",
    name: "display-skill-host-readonly-reason",
    before: "function rt(e, t) {\n  switch (t) {",
    after:
      'function rt(e, t) {\n  switch (t) {\n    case "host_read_only":\n      return "Read-only in this Web connection";',
  },
  {
    file: "c8cba5cdc-B45Vl3wA.js",
    name: "require-explicit-toggle-for-readonly-skills",
    before: "function $e(e) {\n  return e.canToggle === !1 && e.enabled !== !1",
    after: "function $e(e) {\n  return (e.claudexReadOnly === true && e.canToggle !== true) || (e.canToggle === !1 && e.enabled !== !1)",
  },
  {
    file: "cc183b3ab-Dq3NZ8k1.js",
    name: "accept-empty-local-command-catalog",
    before: `var Fe = "empty slash-command list (cold CLI bridge)",
  G = { noToast: !0, silent: !0 };
async function K(t, n) {
  let r = await Pe(t, n);
  if (r.length === 0) throw e(Error(Fe), ["empty slash-command list (cold CLI bridge)"]);
  return r;
}`,
    after: `var G = { noToast: !0, silent: !0 };
async function K(t, n) {
  return Pe(t, n);
}`,
  },
  {
    file: "cc183b3ab-Dq3NZ8k1.js",
    name: "use-remote-command-catalog-in-ssh-drafts",
    before: `function Ie(e, t) {
  let n = e.filter((e) => !F.some((t) => e.description?.trimEnd().endsWith(t)));
  if (!t?.length) return n;
  let r = new Set(n.flatMap((e) => [e.name, ...(e.aliases ?? [])].map((e) => e.toLowerCase())));
  return [...n, ...t.filter((e) => !r.has(e.name.toLowerCase()))].sort((e, t) =>
    e.name.localeCompare(t.name),
  );
}`,
    after: `function Ie(_local, remote) {
  return [...(remote ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}`,
  },
];

/** Pure preparation: validate every pinned anchor before changing any file. */
export function prepareOfficialUiHostCapabilities(sources) {
  const output = new Map(sources);
  for (const rule of hostCapabilityRules) {
    const source = output.get(rule.file);
    if (typeof source !== "string")
      throw Error(`Missing pinned host capability module: ${rule.file}`);
    const first = source.indexOf(rule.before);
    if (
      first < 0 ||
      source.indexOf(rule.before, first + rule.before.length) !== -1
    )
      throw Error(
        `Pinned host capability anchor mismatch: ${rule.file}/${rule.name}`,
      );
    output.set(
      rule.file,
      source.slice(0, first) +
        rule.after +
        source.slice(first + rule.before.length),
    );
  }
  return output;
}

/** Exact derivation for build verification; all unlisted modules are unchanged. */
export function deriveOfficialUiHostCapabilityModule(name, source) {
  if (!Object.hasOwn(hostCapabilityInputHashes, name)) return source;
  if (digest(source) !== hostCapabilityInputHashes[name])
    throw Error(`Pinned host capability source checksum mismatch: ${name}`);
  let result = source;
  for (const rule of hostCapabilityRules.filter((rule) => rule.file === name)) {
    const first = result.indexOf(rule.before);
    if (
      first < 0 ||
      result.indexOf(rule.before, first + rule.before.length) !== -1
    )
      throw Error(
        `Pinned host capability anchor mismatch: ${name}/${rule.name}`,
      );
    result =
      result.slice(0, first) +
      rule.after +
      result.slice(first + rule.before.length);
  }
  return result;
}

export function applyOfficialUiHostCapabilities(assetsDir) {
  const directory = fs.realpathSync(assetsDir);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered official sources are immutable.");
  const names = [...new Set(hostCapabilityRules.map((rule) => rule.file))];
  const sources = new Map(
    names.map((name) => {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isSymbolicLink())
        throw Error("Host capability output cannot be a symlink.");
      return [name, fs.readFileSync(file, "utf8")];
    }),
  );
  // Validate all complete inputs before any output write.
  const prepared = new Map(
    [...sources].map(([name, content]) => [
      name,
      deriveOfficialUiHostCapabilityModule(name, content),
    ]),
  );
  for (const [name, content] of prepared)
    fs.writeFileSync(path.join(directory, name), content);
  return {
    revision: hostCapabilityRevision,
    modules: names.map((name) => ({
      file: name,
      originalSha256: hostCapabilityOriginalHashes[name],
      inputSha256: digest(sources.get(name)),
      outputSha256: digest(prepared.get(name)),
      rules: hostCapabilityRules
        .filter((rule) => rule.file === name)
        .map((rule) => rule.name),
    })),
  };
}
