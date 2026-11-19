import fs from "node:fs";
import path from "node:path";

export const hostExtensionPreviewRevision = "local-extension-preview-v2";
const rules = {
  "c1cbc13cc-BforQKLW.js": [[
    "  return n && r && t.manifest",
    "  return n && (r || !!t.onDiskPath) && t.manifest",
  ]],
  "cc141fa17-DLTOZxOE.js": [
    [
      "    p = n?.localExtensionsDirectoryEnabled === !0,",
      "    p = n?.localExtensionsDirectoryEnabled === !0 || !!t.onDiskPath,",
    ],
    [
      "userConfig: r.settings.userConfig }",
      "userConfig: r.settings.userConfig, savedSecrets: r.settings.savedSecrets }",
    ],
    [
      "userConfig: l.settings.userConfig }",
      "userConfig: l.settings.userConfig, savedSecrets: l.settings.savedSecrets }",
    ],
  ],
  "c8e3f1bbb-DO7N27k5.js": [
    [
      "function ve({ manifest: e, userConfig: t })",
      "function ve({ manifest: e, userConfig: t, savedSecrets })",
    ],
    [
      "    if (r.required) {\n      let e = n[t];",
      "    if (r.required) {\n      if (r.sensitive && !Object.hasOwn(n, t) && savedSecrets?.includes(t)) continue;\n      let e = n[t];",
    ],
  ],
  "cbd3ba55a-DQVGIKtD.js": [[
    "userConfig: r.userConfig }",
    "userConfig: r.userConfig, savedSecrets: r.savedSecrets }",
  ]],
  "cab49831e-ewnjXtlm.js": [[
    "userConfig: n.userConfig }",
    "userConfig: n.userConfig, savedSecrets: n.savedSecrets }",
  ]],
  "ccea1f474-B2jbjvXx.js": [[
    "userConfig: a.userConfig }",
    "userConfig: a.userConfig, savedSecrets: a.savedSecrets }",
  ]],
  "cff43335f-4rcG9JEO.js": [
    [
      "config: r, value: a, onChange: l, descriptionId: u, labelledBy: d",
      "config: r, value: a, onChange: l, descriptionId: u, labelledBy: d, savedSecret",
    ],
    [
      "return J5($, 3, r.title, u, e, n, s, c)",
      "if (r.sensitive && savedSecret && !s) return i(o, { type: e, \"aria-label\": r.title, \"aria-required\": n, \"aria-describedby\": u, value: s, placeholder: \"••••••••\", onChange: c });\n      return J5($, 3, r.title, u, e, n, s, c)",
    ],
    [
      "let $ = J9(43),",
      "let $ = J9(48),",
    ],
    [
      "  if (!o.user_config) return null;",
      "  if (!o.user_config) return null;\n  const savedKeys = c.savedSecrets;",
    ],
    [
      "F = J3($, 12, C, x, P)\n      ? K3(\n          $,\n          12,",
      "F = J4($, 43, C, x, P, savedKeys)\n      ? K4(\n          $,\n          43,",
    ],
    [
      "          P,\n          P.map((e, t) => {",
      "          P,\n          savedKeys,\n          P.map((e, t) => {",
    ],
    [
      "                        value: C[r],",
      "                        value: C[r],\n                        savedSecret: savedKeys?.includes(r),",
    ],
    [
      "      : $[15],\n    I = J2($, 16, N, F)",
      "      : $[47],\n    I = J2($, 16, N, F)",
    ],
  ],
};
export const hostExtensionPreviewFiles = Object.keys(rules);

export function deriveOfficialUiHostExtensionPreviewModule(file, source) {
  for (const [anchor, replacement] of rules[file] ?? []) {
    if (source.split(anchor).length !== 2)
      throw Error("Native extension preview anchor mismatch: " + file);
    source = source.replace(anchor, () => replacement);
  }
  return source;
}

export function applyOfficialUiHostExtensionPreview(directory) {
  for (const file of hostExtensionPreviewFiles) {
    const target = path.join(directory, file);
    fs.writeFileSync(target, deriveOfficialUiHostExtensionPreviewModule(file, fs.readFileSync(target, "utf8")));
  }
  return { revision: hostExtensionPreviewRevision };
}
