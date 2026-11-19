import fs from "node:fs";
import path from "node:path";
import { nativeSkillRules } from "./official-ui-native-skill-rules.mjs";

export const hostSkillInvocationRevision = "claudex-skill-invocation-v1";
const serializer = "shared-m-2-DfdOu-fU.js";
const composer = "shared-28-CcQ2xpO-.js";
const helper = String.raw`
export function claudexRebaseSkillReferences(references, source, prompt) {
  if (!references?.length) return references;
  const text = value => Array.isArray(value)
    ? value.filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n")
    : value;
  source = text(source);
  prompt = text(prompt);
  if (typeof source !== "string" || typeof prompt !== "string")
    throw Error("The selected skills have no outgoing message.");
  if (source === prompt) return references;
  const offset = prompt.indexOf(source);
  if (offset < 0 || prompt.indexOf(source, offset + 1) >= 0)
    throw Error("The selected skills no longer match the outgoing message.");
  return references.map(ref => ({...ref, start: ref.start + offset, end: ref.end + offset}));
}
export function claudexSkillReferences(document, prompt) {
  const references = [];
  const source = T4(document, references);
  return references.length ? claudexRebaseSkillReferences(references, source, prompt) : undefined;
}
export function claudexSkillContext(references) {
  if (!references?.length) return undefined;
  const prefix = "claudex-skill-references-v1:";
  const lines = [];
  let line = prefix + "[";
  for (const ref of references) {
    const item = JSON.stringify(ref);
    if (line.length + item.length + 2 > 4096) {
      lines.push(line + "]");
      line = prefix + "[";
    }
    line += (line.endsWith("[") ? "" : ",") + item;
  }
  lines.push(line + "]");
  if (lines.length > 8) throw Error("Remove some selected skills before sending.");
  return lines;
}
`;
const rules = [
  {
    file: serializer,
    name: "capture-original-serializer-spans",
    before: 'var T4 = (e) => {',
    after: 'var T4 = (e, claudexReferences) => {',
  },
  {
    file: serializer,
    name: "record-only-skill-chip-nodes",
    before: '          let n = v2(e.attrs?.skillId) || e.attrs?.skillDisplayName || "";\n          t += `/${n}`;',
    after: String.raw`          let n = v2(e.attrs?.skillId) || e.attrs?.skillDisplayName || "";
          if (claudexReferences && n && e.attrs?.slashRouting !== "host") {
            const start = t.replaceAll("\u200B", "").length;
            const end = start + n.length + 1;
            const remote = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):(.+)$/i.exec(n);
            claudexReferences.push(remote
              ? {kind: "remote", connectorId: remote[1], name: remote[2], start, end}
              : {kind: "local", name: n, start, end});
          }
          t += ` + "`/${n}`" + ";",
  },
  {
    file: serializer,
    name: "account-for-original-trim",
    before: '    return (a(e), t.replaceAll("\\u200B", "").replaceAll("\\u00A0", " ").trim());\n  },\n  dJ =',
    after: String.raw`    a(e);
    t = t.replaceAll("\u200B", "").replaceAll("\u00A0", " ");
    if (claudexReferences?.length) {
      const trim = t.length - t.trimStart().length;
      for (const ref of claudexReferences) {
        ref.start -= trim;
        ref.end -= trim;
      }
    }
    return t.trim();
  },
  dJ =`,
  },
  {
    file: serializer,
    name: "export-skill-reference-reader",
    before: "\n  T4,\n",
    after: "\n  T4,\n",
    append: helper,
  },
  {
    file: composer,
    name: "import-skill-reference-reader",
    before: "  T4,\n  TH as Yc,",
    after: "  T4,\n  claudexSkillReferences,\n  claudexSkillContext,\n  TH as Yc,",
  },
  {
    file: composer,
    name: "bind-submitted-skill-references",
    before: "            q = dl(u, G),",
    after: '            claudexReferences = claudexSkillReferences(u, G),\n            claudexSkillLines = claudexSkillContext(claudexReferences),\n            q = dl(u, G),',
  },
  {
    file: composer,
    name: "existing-chat-and-task",
    before: "                ...(Ne?.hidden === void 0 ? null : { hiddenContext: Ne.hidden }),",
    after: "                ...(claudexReferences ? { skillReferences: claudexReferences } : {}),\n                ...(claudexSkillLines === undefined\n                  ? (Ne?.hidden === void 0 ? {} : { hiddenContext: Ne.hidden })\n                  : { hiddenContext: [...claudexSkillLines, ...(Ne?.hidden ?? [])] }),",
  },
  {
    file: composer,
    name: "new-local-task",
    before: "              accountGeneration: ie,\n              rawPrompt: Y",
    after: "              accountGeneration: ie,\n              ...(claudexReferences ? { skillReferences: claudexReferences } : {}),\n              rawPrompt: Y",
  },
  {
    file: composer,
    name: "new-chat",
    before: '                ...(Le === null\n                  ? {}\n                  : F === null\n                    ? { pluginChipLine: Le }\n                    : { hiddenOpeningContext: [Le] }),',
    after: '                ...(Le !== null && F === null ? { pluginChipLine: Le } : {}),\n                ...(claudexSkillLines ? { claudexSkillLines } : {}),\n                ...(claudexSkillLines || (Le !== null && F !== null)\n                  ? { hiddenOpeningContext: [...(claudexSkillLines ?? []), ...(Le !== null && F !== null ? [Le] : [])] }\n                  : {}),',
  },
  {
    file: composer,
    name: "retain-skill-context-in-new-chat-options",
    before: "      hiddenOpeningContext: o,\n      requiredHiddenLines: s,",
    after: "      hiddenOpeningContext: o,\n      claudexSkillLines,\n      requiredHiddenLines: s,",
  },
  {
    file: composer,
    name: "retain-skill-context-in-new-chat-creation",
    before: "    ...(o ? { hiddenOpeningContext: o } : {}),",
    after: "    ...(o ? { hiddenOpeningContext: o } : {}),\n    ...(claudexSkillLines ? { claudexSkillLines } : {}),",
  },
  {
    file: "shared-4-Kt-jV-IU.js",
    name: "preserve-new-chat-selection-during-navigation",
    before: "          pluginChipLine: n.pluginChipLine,",
    after: '          pluginChipLine: n.pluginChipLine,\n          hiddenContext: n.claudexSkillLines,',
  },
  {
    file: "shared-160-BGt89-ku.js",
    name: "retain-skill-context-in-post-navigation-send",
    before: "              ...e,\n              createConversationParams: e.inlineCreateConversationParams,",
    after: "              ...e,\n              hiddenContext: e.claudexSkillLines ?? e.hiddenContext,\n              createConversationParams: e.inlineCreateConversationParams,",
  },
  {
    file: "shared-1-B16QIYNI.js",
    name: "carry-skill-references-to-rest-completion",
    before: "        pluginChipLine: Re,\n      }) => {",
    after: "        pluginChipLine: Re,\n        hiddenContext: claudexSkillContext,\n      }) => {",
  },
  {
    file: "shared-1-B16QIYNI.js",
    name: "keep-original-rest-context",
    before: '            hiddenContext:\n              Re !== void 0 && n === M9.APPEND_MESSAGE_WITH_COMPLETION && MN(v4) ? [Re] : void 0,',
    after: '            hiddenContext: [\n              ...(claudexSkillContext?.filter(line => line.startsWith("claudex-skill-references-v1:")) ?? []),\n              ...(Re !== void 0 && n === M9.APPEND_MESSAGE_WITH_COMPLETION && MN(v4) ? [Re] : []),\n            ],',
  },
];

export function deriveOfficialUiHostSkillInvocationModule(file, source) {
  let output = source;
  for (const rule of [...rules, ...nativeSkillRules]) {
    if (rule.file !== file) continue;
    const at = output.indexOf(rule.before);
    if (at < 0 || output.indexOf(rule.before, at + rule.before.length) >= 0)
      throw Error("Original skill invocation anchor mismatch: " + rule.name);
    output = output.slice(0, at) + rule.after + output.slice(at + rule.before.length);
    if (rule.append) output += rule.append;
  }
  return output;
}

export function applyOfficialUiHostSkillInvocation(directory) {
  for (const file of new Set([...rules, ...nativeSkillRules].map(rule => rule.file))) {
    const location = path.join(directory, file);
    const source = fs.readFileSync(location, "utf8");
    fs.writeFileSync(location, deriveOfficialUiHostSkillInvocationModule(file, source));
  }
  return hostSkillInvocationRevision;
}
