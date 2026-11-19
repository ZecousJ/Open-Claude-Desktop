/** Bind the original model selector to account preferences and conversation loading. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const modelCatalogStateRevision = "original-model-catalog-state-v6";
const menuModules = ["shared-7-D_yzHgAj.js", "shared-8-B9DjIUqu.js"];
export const modelMenuOrderSource = String.raw`function claudexSortModelRows(options) {
  const vendors = new Map();
  const tier = ["astra", "fable", "opus", "ultra", "pro", "sol", "sonnet", "terra", "flash", "haiku", "mini", "lite", "fast", "nano"];
  for (const option of options) {
    const id = /^composer \d/i.test(option.name ?? "")
      ? option.name.toLowerCase().replaceAll(" ", "-")
      : (option.model ?? option.id).split("/").at(-1).toLowerCase();
    const family = id.match(/^(gpt|chatgpt|codex|o(?=\d)|claude|grok|composer|gemini|qwen|deepseek)/)?.[0] ?? "other";
    const vendor = ({ gpt: "openai", chatgpt: "openai", codex: "openai", o: "openai", grok: "xai", composer: "xai" })[family] ?? family;
    const releaseFamily = vendor === "openai" && family !== "o" ? "gpt" : family;
    const version = family === "other" ? null : id.match(/(?:^|[-a-z])v?(\d{1,2})(?:[.-](\d{1,2}))?(?:[.-](\d{1,2}))?(?=[-._]|$)/);
    const variant = tier.findIndex(name => id.split(/[-._]/).includes(name));
    const rank = !version || variant < 0 ? tier.indexOf("sol") : variant;
    const build = !!version && (/(?:^|[-._])latest(?:[-._]build)?$/.test(id) || /\(latest build\)$/i.test(option.name ?? ""));
    const row = { option, major: Number(version?.[1] ?? -1), minor: Number(version?.[2] ?? 0), patch: Number(version?.[3] ?? 0), rank, build };
    if (!vendors.has(vendor)) vendors.set(vendor, new Map());
    const families = vendors.get(vendor);
    if (!families.has(releaseFamily)) families.set(releaseFamily, []);
    families.get(releaseFamily).push(row);
  }
  return [...vendors.values()].flatMap(families => [...families.values()].flatMap(rows =>
    rows.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch ||
      a.rank - b.rank || Number(b.build) - Number(a.build)).map(row => row.option),
  ));
}`;
export const modelCatalogStateInputHashes = {
  "shared-7-D_yzHgAj.js": "a347d7e2f309527f347f78257aad61f57750d0f487036c6108add49ab08e43f8",
  "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js": "b2daaa07022ef00e4cc15c1d61a6ff864740dc6b0671955d407fb4c60b73e1f6",
  "shared-1-B16QIYNI.js": "03ac618279fe11933a623396eaf68a1c01563d47f92733dea0ecc9e1986b9b5f",
  "shared-8-B9DjIUqu.js": "4e83ec88a5928017548e8dac8d5e8b67c084e7a60c360626a4c9b723ed632c43",
};
export const modelCatalogStateOriginalHashes = {
  "shared-7-D_yzHgAj.js": "8da8d183c28898bb8a118a2c575798a4a53b728cae06e0bdcd7ebd8a0f533e1a",
  "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js": "06181192d0913e979ee2bd32ad3d83219e49ab69517b3d6e0931f1bf97224df2",
  "shared-1-B16QIYNI.js": "eb4d096ce0b1ca2e7531e5dfde17be72b44c27c49bd36aaea394dd0ae413ebb0",
  "shared-8-B9DjIUqu.js": "4011115b803a0e8a52b5916a9bde4d1829d476e68d1d19ea1634e08b1fdd1497",
};
export const modelCatalogStateRules = [
  {
    file: "shared-7-D_yzHgAj.js",
    name: "sort-both-model-menu-sections-within-provider",
    before: "    T = w.filter(sh),\n    E = w.filter(uo),",
    after: "    T = claudexSortModelRows(w.filter(sh)),\n    E = claudexSortModelRows(w.filter(uo)),",
  },
  {
    file: "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js",
    name: "chat-model-loading-reaches-composer",
    before: "                                    isLoading: tD,",
    after: "                                    isLoading: tD,\n                                    sessionRecordLoaded: Z.ready || !!a.initialDraftModel,",
  },
  {
    file: "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js",
    name: "hub-composer-reads-web-search-eligibility",
    before: "function Ffe(e) {\n  let $ = J9(248),",
    after: 'function Ffe(e) {\n  const { hasCapability: claudexChatCapability } = Ta("chat");\n  const claudexWebSearchAvailable = ca("web_search").isAvailable;\n  const claudexHubCanSearch = u(null);\n  claudexHubCanSearch.current = model => claudexWebSearchAvailable && claudexChatCapability(model, "web_search");\n  let $ = J9(248),',
  },
  {
    file: "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js",
    name: "hub-send-uses-the-selected-model-for-web-search",
    before: 'function M9(e, t, n, r) {\n  let i = Efe(e, r);\n  n === "unstated" && delete i.enabled_web_search;\n  let a = PS(i);\n  return {\n    model: e.model,\n    settingsDelta: n === "forcedOn" ? fA(a, i) : a,',
    after: 'function M9(e, t, n, r, canSearch) {\n  let i = Efe(e, r);\n  const searchable = canSearch(e.model);\n  if (n === "unstated") delete i.enabled_web_search;\n  else if (!searchable) i.enabled_web_search = false;\n  let a = PS(i);\n  return {\n    model: e.model,\n    settingsDelta: n === "forcedOn" && searchable ? fA(a, i) : a,',
  },
  ...[
    "M9(I9(e, be.current), !1, Z, we.current)",
    "M9(E, u !== void 0, Z, we.current)",
    "M9(E, g !== void 0, Z, we.current)",
  ].map((call, index) => ({
    file: "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js",
    name: `hub-send-web-search-eligibility-${index + 1}`,
    before: call,
    after: `${call.slice(0, -1)}, claudexHubCanSearch.current)`,
  })),
  {
    file: "shared-8-B9DjIUqu.js",
    name: "sort-model-menu-rows-within-provider",
    before: "((fe = e), (ue = e.filter(oI)), (de = e.filter(CC)), K3($, 0, Q, ue, de, fe));",
    after: "((fe = e), (ue = claudexSortModelRows(e.filter(oI))), (de = claudexSortModelRows(e.filter(CC))), K3($, 0, Q, ue, de, fe));",
  },
  {
    file: "shared-8-B9DjIUqu.js",
    name: "keep-provider-together-in-existing-conversation-more-menu",
    before: "X = (J ? [U, W].map((e) => e.filter((e) => e.model !== L)) : [W]).filter(GJ),",
    after: "X = (J ? [claudexSortModelRows(I.filter((e) => e.model !== L))] : [W]).filter(GJ),",
  },
  {
    file: "shared-8-B9DjIUqu.js",
    name: "selector-reads-current-record-state",
    before: "var rA = x$(function (e) {\n  let $ = J9(274),",
    after: "var rA = x$(function (e) {\n  const claudexModelSource = AA();\n  let $ = J9(274),",
  },
  {
    file: "shared-8-B9DjIUqu.js",
    name: "pending-chat-record-uses-original-model-loading",
    before: "  if (B)\n    return J4($, 145, d, f, o, c)",
    after: `  if (!claudexModelSource.isNewConversation && !claudexModelSource.sessionRecordLoaded && !claudexModelSource.localSessionId)
    return gl(Hw, { conversationUuid: h, disabled: !0, placement: t, textSize: o, showChevron: l });
  if (B)
    return J4($, 145, d, f, o, c)`,
  },
  {
    file: "shared-1-B16QIYNI.js",
    name: "account-selection-without-recorded-console-default",
    before: `function JD(e) {
  let t = Fj(e),
    n = OV("console_default_model", "model", null, lN),
    r = OV("console_default_model", "overrideSticky", !1, L_),
    i = OV("console_default_model", "nuxId", null, lN);
  return (r && n && DBq(n, i), t || n || "claude-3-5-haiku-latest");
}`,
    after: `function JD(e) {
  let t = Fj(e),
    n = ty().entry?.model;
  return t || (e ? "" : n) || "";
}`,
  },
  {
    file: "shared-8-B9DjIUqu.js",
    name: "new-conversation-uses-current-account-selection",
    before: "oe = (t ? ae : null) ?? n ?? ne,",
    after: "oe = (t ? ae || void 0 : null) ?? n ?? ne,",
  },
  {
    file: "shared-1-B16QIYNI.js",
    name: "completion-reads-web-search-eligibility",
    before: "  let D = mOx(),\n    { applicationType: O } = F3(),",
    after: '  const { hasCapability: claudexChatCapability } = eSS("chat");\n  const claudexWebSearchAvailable = je("web_search").isAvailable;\n  let D = mOx(),\n    { applicationType: O } = F3(),',
  },
  {
    file: "shared-1-B16QIYNI.js",
    name: "completion-uses-the-selected-model-for-web-search",
    before: "        let Ze = a(),\n          Qe = ee || X,",
    after: '        let Qe = ee || X,\n          Ze = claudexWebSearchAvailable && claudexChatCapability(Qe, "web_search")\n            ? a()\n            : a().filter(tool => tool.type !== "web_search_v0"),',
  },
  {
    file: "shared-1-B16QIYNI.js",
    name: "completion-refreshes-web-search-eligibility",
    before: "        le,\n        me,\n        a,\n        o,\n        fe,",
    after: "        le,\n        me,\n        a,\n        o,\n        claudexChatCapability,\n        claudexWebSearchAvailable,\n        fe,",
  },
  {
    file: "shared-8-B9DjIUqu.js",
    name: "original-loading-and-empty-model-states",
    before: "xe = ye.length === 0 ? he : null,",
    after: 'xe = !ie || (t && !l && !ae && !n && !r) ? "loading" : ye.length === 0 && !ae && !n && !r ? "empty" : null,',
  },
];
const sha = (source) => createHash("sha256").update(source).digest("hex");
export function deriveOfficialModelCatalogStateModule(file, source) {
  if (!Object.hasOwn(modelCatalogStateInputHashes, file)) return source;
  if (sha(source) !== modelCatalogStateInputHashes[file])
    throw Error("Pinned model catalog state input mismatch: " + file);
  let output = source;
  for (const rule of modelCatalogStateRules.filter((rule) => rule.file === file)) {
    if (output.split(rule.before).length !== 2)
      throw Error("Pinned model catalog state anchor mismatch: " + rule.name);
    output = output.replace(rule.before, rule.after);
  }
  return menuModules.includes(file) ? modelMenuOrderSource + "\n" + output : output;
}
export function applyOfficialModelCatalogState(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).some((part) => part === ".restore" || part === "claude-frontend-4.4212.0"))
    throw Error("Recovered sources are immutable");
  const modules = Object.keys(modelCatalogStateInputHashes).map((file) => {
    const location = path.join(directory, file);
    const output = deriveOfficialModelCatalogStateModule(file, fs.readFileSync(location, "utf8"));
    fs.writeFileSync(location, output);
    return {
      file,
      originalSha256: modelCatalogStateOriginalHashes[file],
      inputSha256: modelCatalogStateInputHashes[file],
      outputSha256: sha(output),
      rules: modelCatalogStateRules.filter((rule) => rule.file === file).map((rule) => rule.name),
    };
  });
  return { revision: modelCatalogStateRevision, modules };
}
