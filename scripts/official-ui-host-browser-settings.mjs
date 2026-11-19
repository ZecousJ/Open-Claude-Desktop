import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const settings = "c71860c77-S3armOsG.js";
export const hostBrowserSettingsRevision = "claudex-browser-settings-v4";
export const hostBrowserSettingsInputHashes = {
  [settings]:
    "43ded6db32c51fded36ee0f3757c5d18222a992707b3fbdafd2144f6d7ce96a5",
};
export const hostBrowserSettingsOriginalHashes = {
  [settings]:
    "6bf441f08d8b47656b91d716a0c068f86c081559e6e681173b2277c42a0962a7",
};
export const hostBrowserSettingsRules = [
  {
    name: "built-in-browser-approval",
    before: '    s = V("cowork_chrome_automode_default_main"),',
    after:
      '    builtIn = t.claudexBuiltInBrowserSettings === true,\n    s = V("cowork_chrome_automode_default_main") && !builtIn,',
  },
  {
    name: "built-in-browser-copy",
    before:
      '              description: l(X, {\n                defaultMessage:\n                  "Claudex will browse and interact with any website in Chrome without asking.',
    after:
      '              description: builtIn ? l(X, {defaultMessage: "Let Claudex browse in its built-in browser without asking on each site. Applies to new sessions. Your organization’s browser policy still applies.", id: "claudexBuiltInBrowserApproval"}) : l(X, {\n                defaultMessage:\n                  "Claudex will browse and interact with any website in Chrome without asking.',
  },
  {
    name: "browser-approval-row",
    before:
      "  let d = J3($, 4, r, s, o)\n      ? K3(\n          $,\n          4,\n          r,\n          s,\n          o,\n          !s &&",
    after: "  let d = !s &&",
  },
  {
    name: "separate-chrome-inventory",
    before:
      "            }),\n        )\n      : $[7],\n    f = J1($, 8, i)\n      ? K1($, 8, i, i ? l(gi, {}) : l(ct, { framed: !0, showHeading: !0, interactive: !0 }))\n      : $[9];",
    after:
      "            }),\n    f = builtIn ? null : i ? l(gi, {}) : l(ct, { framed: !0, showHeading: !0, interactive: !0 });",
  },
  {
    name: "claudex-chrome-extension-control",
    before: "function _i(e) {",
    after: `function ClaudexChromeExtension({ status }) {
  const [error, setError] = n("");
  const [pending, setPending] = n(false);
  async function run(key, value) {
    setError("");
    setPending(true);
    try { await H.setPreference(key, value); }
    catch (e) { setError(e instanceof Error ? e.message : "Chrome extension setup failed."); }
    finally { setPending(false); }
  }
  return a("div", { "data-testid": "claudex-chrome-extension", children: [
    l(J, {
      label: "Claudex Chrome extension",
      description: "Enable this computer’s Chrome connection, then load the Claudex extension in Chrome.",
      control: (ids) => l(P, {
        "aria-labelledby": ids.labelId,
        "aria-describedby": ids.descriptionId,
        checked: status.enabled,
        disabled: pending,
        onCheckedChange: (enabled) => void run("claudexChromeExtensionEnabled", enabled),
      }),
    }),
    l("p", { className: "text-sm text-text-300", children: status.enabled ? (status.connected ? "Extension connected." : "Extension host enabled; no extension connected.") : "Extension host disabled." }),
    l("p", { className: "text-sm text-text-300", children: "In Chrome, open Extensions, turn on Developer mode, choose Load unpacked, and select this folder:" }),
    l("p", { className: "text-sm break-all select-text", children: status.bundlePath }),
    l("button", { type: "button", className: "text-sm underline", disabled: pending, onClick: () => void run("claudexChromeExtensionReveal", true), children: "Show extension folder" }),
    error ? l("p", { role: "alert", className: "text-sm text-red-500", children: error }) : null,
  ] });
}
function _i(e) {`,
  },
  {
    name: "show-claudex-chrome-extension-in-browser-use",
    before: `  return J3($, 10, n, d, f)
    ? K3($, 10, n, d, f, a(ge, { title: c, description: u, children: [d, f, n] }))
    : $[13];`,
    after: `  return a(ge, { title: c, description: u, children: [d, f, t.claudexChromeExtension ? l(ClaudexChromeExtension, { status: t.claudexChromeExtension }) : null, n] });`,
  },
  {
    name: "show-supported-browser-approval",
    before: "          W && G && ae && m\n            ? l(_i,",
    after:
      "          m && (m.claudexBuiltInBrowserSettings || m.claudexChromeExtension || (W && G && ae))\n            ? l(_i,",
  },
  {
    name: "startup-login-state",
    before: `function Ca() {
  let $ = J9(116),
    [t, r] = n(!1),`,
    after: `function Ca() {
  let $ = J9(116),
    [t, r] = n({}),`,
  },
  {
    name: "startup-login-initial-read",
    before: "L.isStartupOnLoginEnabled().then(r),",
    after: "L.isStartupOnLoginEnabled().then((value) => r({ value }), () => {}),",
  },
  {
    name: "startup-login-write-readback",
    before: `K0($, 8, (e) => {
          (r(e), L?.setStartupOnLoginEnabled?.(e));
        })`,
    after: `K0($, 8, async (e) => {
          r((state) => ({ value: state.value, pending: !0 }));
          let writeFailed;
          try {
            await L.setStartupOnLoginEnabled(e);
          } catch {
            writeFailed = "refused";
          }
          try {
            const value = await L.isStartupOnLoginEnabled();
            r({ value, writeFailed: value === e ? writeFailed : "refused" });
          } catch {
            r({ writeFailed: "refused" });
          }
        })`,
  },
  {
    name: "startup-login-switch-binding",
    before: "binding: { value: t, set: D, available: !0 }",
    after: "binding: { ...t, set: D, available: !0 }",
  },
  {
    name: "remote-control-power-fallback",
    before: `    ke = J5($, 77, ye, be, Te, Y, De)
      ? K5(
          $,
          77,
          ye,
          be,
          Te,
          Y,
          De,
          a(ge, { id: "general-desktop", title: pe, children: [J, me, ye, be, Te, Y, Ee, De, Oe] }),
        )
      : $[82],`,
    after: `    remotePower = m?.claudexRemoteReachabilityPreference === true
      ? l(ClaudexRemotePowerSetting, {
          label: l(X, { defaultMessage: "Keep this computer awake for Remote Control", id: "claudexRemoteReachability" }),
          description: l(X, { defaultMessage: "Keeps this computer from going to sleep on its own. If it does go to sleep, it isn’t reachable until it wakes up.", id: "claudexRemoteReachabilityDescription" }),
          control: (e) => l(ClaudexRemotePowerSwitch, {
            "aria-labelledby": e.labelId,
            "aria-describedby": e.descriptionId,
            "data-testid": "claudex-remote-reachability",
            checked: m.remoteControlStayReachable === true,
            onCheckedChange: (enabled) => {
              void H?.setPreference?.("remoteControlStayReachable", enabled)?.catch(console.error);
            },
          }),
        })
      : null,
    ke = a(ge, { id: "general-desktop", title: pe, children: [J, me, ye, be, Te, Y, remotePower, Ee, De, Oe] }),`,
  },
  {
    name: "reference-settings-row-outside-shadowed-scope",
    before: "function Ca() {",
    after: "const ClaudexRemotePowerSetting = J;\nconst ClaudexRemotePowerSwitch = P;\nfunction Ca() {",
  },
].map((rule) => ({ file: settings, ...rule }));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function deriveOfficialUiHostBrowserSettingsModule(name, source) {
  if (name !== settings) return source;
  if (hash(source) !== hostBrowserSettingsInputHashes[name])
    throw Error("Pinned browser settings checksum mismatch");
  let output = source;
  for (const rule of hostBrowserSettingsRules) {
    if (output.split(rule.before).length !== 2)
      throw Error("Pinned browser settings anchor mismatch: " + rule.name);
    output = output.replace(rule.before, rule.after);
  }
  return output;
}
export function applyOfficialUiHostBrowserSettings(directory) {
  const root = fs.realpathSync(directory);
  if (root.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const filename = path.join(root, settings);
  if (fs.lstatSync(filename).isSymbolicLink())
    throw Error("Symlink output rejected");
  const original = fs.readFileSync(filename, "utf8");
  const output = deriveOfficialUiHostBrowserSettingsModule(settings, original);
  fs.writeFileSync(filename, output);
  return {
    revision: hostBrowserSettingsRevision,
    modules: [
      {
        file: settings,
        originalSha256: hostBrowserSettingsOriginalHashes[settings],
        inputSha256: hash(original),
        outputSha256: hash(output),
        rules: hostBrowserSettingsRules.map((rule) => rule.name),
      },
    ],
  };
}
