const serializer = "shared-m-2-DfdOu-fU.js";
const codeComposer = "c1958b152-CFWu6jfy.js";
const codePage = "cc43287c9-BDrqHHqn.js";
const coworkPage = "c21f11e6d-CzWHzVHw.js";
const miniCowork = "c6eb5f8cf-CYBh3jEI.js";
const coworkDraft = "shared-18-BX5JXrGK.js";
const coworkSession = "cb1e253a0-D3VA46OS.js";
const remoteCowork = "shared-2-CuvP2TaI.js";
const codeStart = "shared-m-4-CbJwwS_m.js";
const remoteCode = "c5da7eb42-BOzerWAp.js";
const codeTranscript = "c06cf64bb-CcaN03HG.js";

const restoreCodeSkillChips = `
export function claudexRestoreCodeSkillChips(document, text, references, makeChip) {
  const chips = new Map();
  let marker = "\\uE000";
  while (text.includes(marker)) marker += "\\uE001";
  const marked = references.reduceRight((value, ref, index) => {
    const key = marker + index + "\\uE000";
    chips.set(key, makeChip(text.slice(ref.start + 1, ref.end), ref.name));
    return value.slice(0, ref.start) + key + value.slice(ref.end);
  }, text);
  const parsed = document(marked);
  function restore(node) {
    if (node.type === "text") {
      return node.text.split(new RegExp("(" + marker + "[0-9]+\\uE000)", "u")).flatMap(part =>
        chips.has(part) ? [chips.get(part)] : part ? [{ ...node, text: part }] : []);
    }
    return [{ ...node, ...(node.content && { content: node.content.flatMap(restore) }) }];
  }
  return restore(parsed)[0];
}
`;

const rule = (file, name, before, after) => ({ file, name, before, after });
const rebaseImport = (file, firstImport) => rule(file, "import-skill-span-rebase", firstImport,
  `import { claudexRebaseSkillReferences } from "./${serializer}";\n${firstImport}`);

export const nativeSkillRules = [
  rebaseImport(codePage, 'import { Qr as y, WX as _, ph as v } from "./preload-helper-Cq29w_VG.js";'),
  rebaseImport(codeStart, 'import { YJ, vL } from "./rolldown-runtime-BmbMa3VH.js";'),
  rebaseImport(remoteCode, 'import { Ec as d, Qr as h, WX as f, ph as p, sc as m } from "./preload-helper-Cq29w_VG.js";'),
  rebaseImport(coworkDraft, 'import { Qr as Au, ph as ZR } from "./preload-helper-Cq29w_VG.js";'),
  rebaseImport(coworkPage, 'import { Qr as t, ph as e } from "./preload-helper-Cq29w_VG.js";'),
  rebaseImport(miniCowork, 'import { ph as t } from "./preload-helper-Cq29w_VG.js";'),
  rule(codeComposer, "import-code-skill-reader", "  T4 as vt,\n  cE as gt,",
    "  T4 as vt,\n  claudexRebaseSkillReferences,\n  claudexSkillReferences,\n  cE as gt,"),
  rule(codeComposer, "read-code-skill-chips", "                  n = os(Fu(J), t),\n                  {\n                    shellExposed: r,",
    "                  n = os(Fu(J), t),\n                  claudexReferences = t || e?.machineSend ? undefined : claudexSkillReferences(n.json, n.serialized),\n                  claudexFirst = claudexReferences?.[0],\n                  claudexCodeControl = claudexFirst?.start === 0 && claudexFirst.kind === 'local' && ['compact', 'review'].includes(claudexFirst.name),\n                  claudexLeadingSkill = claudexFirst?.start === 0 && !claudexCodeControl,\n                  {\n                    shellExposed: r,"),
  rule(codeComposer, "distinguish-selected-skills-from-shell-input", "                  } = xp(n.raw, { bashMode: t, cliCommandForced: n.cliCommandForced }, Oi);",
    "                  } = claudexLeadingSkill ? {} : xp(n.raw, { bashMode: t, cliCommandForced: n.cliCommandForced }, Oi);"),
  rule(codeComposer, "rebase-cleaned-code-skill-spans", '                  h = (t ? `! ${d}` : d) + m,',
    '                  h = (t ? `! ${d}` : d) + m,\n                  claudexOutgoingReferences = claudexRebaseSkillReferences(claudexCodeControl ? undefined : claudexReferences, n.serialized, h),'),
  rule(codeComposer, "submit-code-skill-chips", "                      hostCommandForced: c,\n                      cliCommandForced: l,",
    "                      hostCommandForced: c,\n                      cliCommandForced: l,\n                      ...(claudexOutgoingReferences ? { skillReferences: claudexOutgoingReferences } : {}),"),
  {
    ...rule(codeComposer, "restore-code-skill-chips-in-editor",
      "              : Hr(t, n?.literal === !0 ? { parseLists: !1, parseFences: !1 } : void 0);",
      "              : n?.restored?.skillReferences?.length\n                ? claudexRestoreCodeSkillChips(Hr, t, n.restored.skillReferences, (id, name) => Gt(id, name, '')[0])\n                : Hr(t, n?.literal === !0 ? { parseLists: !1, parseFences: !1 } : void 0);"),
    append: restoreCodeSkillChips,
  },

  rule(codePage, "preserve-parked-code-skill-chips", "        text: _.text,\n        typedText: _.typedText,",
    "        text: _.text,\n        skillReferences: _.skillReferences,\n        typedText: _.typedText,"),
  rule(codePage, "rebase-followup-code-skill-chips", "    dt = Be + ut + He(iN(rt, Ye, y));",
    "    dt = Be + ut + He(iN(rt, Ye, y)),\n    claudexReferences = claudexRebaseSkillReferences(ve?.skillReferences, X, dt);"),
  rule(codePage, "park-followup-code-skill-chips", "          text: dt,\n          displayText: We,",
    "          text: dt,\n          skillReferences: claudexReferences,\n          displayText: We,"),
  rule(codePage, "send-followup-code-skill-chips", "        text: dt,\n        typedText: ve?.typedText,",
    "        text: dt,\n        skillReferences: claudexReferences,\n        typedText: ve?.typedText,"),
  rule(codePage, "rebase-opening-code-skill-chips", "                  Et = Tt !== void 0 && !SC.test(wt.trim()) ? Tt(wt) : wt;",
    "                  Et = Tt !== void 0 && !SC.test(wt.trim()) ? Tt(wt) : wt,\n                  claudexReferences = claudexRebaseSkillReferences(n?.skillReferences, e, Et);"),
  rule(codePage, "send-detached-opening-code-skill-chips", "                          text: Et,\n                          typedText: n?.typedText,",
    "                          text: Et,\n                          skillReferences: claudexReferences,\n                          typedText: n?.typedText,"),
  rule(codePage, "send-opening-code-skill-chips", "                    text: Et,\n                    typedText: n?.typedText,",
    "                    text: Et,\n                    skillReferences: claudexReferences,\n                    typedText: n?.typedText,"),
  rule(codePage, "send-local-opening-code-skill-chips", "                        message: N,\n                        typedText: P,",
    "                        message: N,\n                        ...(claudexOpeningReferences ? { skillReferences: claudexOpeningReferences } : {}),\n                        typedText: P,"),
  rule(codePage, "receive-opening-code-skill-chips", "                text: N,\n                typedText: P,",
    "                text: N,\n                skillReferences: claudexOpeningReferences,\n                typedText: P,"),
  rule(codePage, "send-cloud-opening-code-skill-chips", "                      initialMessage: t,\n                      fileAttachments: le,",
    "                      initialMessage: t,\n                      skillReferences: claudexRebaseSkillReferences(claudexOpeningReferences, N, t.message.content),\n                      fileAttachments: le,"),
  rule(codePage, "restore-confirmed-queued-code-skill-chips",
    "                  if ((as(e.id), Dt() === S && g(), f.length > 0 && (hc(f, S), t && Oo.current))) {\n                    cc(f, S);",
    "                  const restored = e.claudexSkillSelection;\n                  const skillReferences = claudexRebaseSkillReferences(restored?.references, restored?.text, f);\n                  if ((as(e.id), Dt() === S && g(), f.length > 0 && (hc(f, S), t && Oo.current))) {\n                    cc(f, S);\n                    if (skillReferences?.length) {\n                      const draft = Oo.current.getText();\n                      Oo.current.setText(draft, { restored: { typedText: undefined, skillReferences: claudexRebaseSkillReferences(skillReferences, f, draft) } });\n                    }"),
  rule(codePage, "restore-queued-code-skill-chips", "s.setText(d === null ? f : __claudexCodeTakebackText(f, d, q?.id), { restored: { typedText: void 0, bashMode: h } })",
    "s.setText(d === null ? f : __claudexCodeTakebackText(f, d, q?.id), { restored: { typedText: void 0, bashMode: h, skillReferences: claudexRebaseSkillReferences(e.claudexSkillSelection?.references, e.claudexSkillSelection?.text, d === null ? f : __claudexCodeTakebackText(f, d, q?.id)) } })"),
  rule(codePage, "restore-parked-code-skill-chips", "o.setText(u === null ? d : __claudexCodeTakebackText(d, u, J), { restored: { typedText: void 0 } })",
    "o.setText(u === null ? d : __claudexCodeTakebackText(d, u, J), { restored: { typedText: void 0, skillReferences: claudexRebaseSkillReferences(i.skillReferences, i.text, u === null ? d : __claudexCodeTakebackText(d, u, J)) } })"),
  rule(codeTranscript, "read-queued-code-skill-chips", "      (oe = r.type === \"user\" ? $u(r.message?.content) : void 0),",
    "      (oe = r.type === \"user\" ? $u(r.message?.content) : void 0),\n      (claudexSelection = r.type === \"user\" ? r.claudexSkillSelection : undefined),"),
  rule(codeTranscript, "declare-queued-code-skill-selection", "    ie,\n    oe,\n    se = !1,",
    "    ie,\n    oe,\n    claudexSelection,\n    se = !1,"),
  rule(codeTranscript, "attach-queued-code-skill-chips-to-transcript-entry", '          ...(oe && e === "user" && { sessionMentions: oe }),',
    '          ...(oe && e === "user" && { sessionMentions: oe }),\n          ...(e === "user" && claudexSelection && { claudexSkillSelection: claudexSelection }),'),

  rule("c6b8adeaf-9EdC4eB_.js", "pass-code-skill-chips-to-transport", "                e.limitContinue,\n              );",
    "                e.limitContinue,\n                e.skillReferences,\n              );"),
  rule("c6b8adeaf-9EdC4eB_.js", "preserve-skill-chips-in-optimistic-code-row",
    "    t && !Ua() ? e.seededSummon && !0 : e.seededSummon,\n  );\n}\nfunction Ja(e, t, n, r, i, a, o, s) {",
    "    t && !Ua() ? e.seededSummon && !0 : e.seededSummon,\n    e.skillReferences,\n  );\n}\nfunction Ja(e, t, n, r, i, a, o, s, skillReferences) {"),
  rule("c6b8adeaf-9EdC4eB_.js", "carry-optimistic-code-skill-selection",
    '    isOptimisticEcho: !0,\n    message: { role: "user", content: c },',
    '    isOptimisticEcho: !0,\n    message: { role: "user", content: c },\n    ...(skillReferences?.length ? { claudexSkillSelection: { text: t, references: skillReferences } } : {}),'),
  rule("cef1e6037-DIC2zPYg.js", "receive-local-code-skill-chips", "let [i, o, s, c, l, u, d, f, p, m, h, g, _, v, y, b, x, ee, S, C] = r,",
    "let [i, o, s, c, l, u, d, f, p, m, h, g, _, v, y, b, x, ee, S, C, claudexReferences] = r,"),
  rule("cef1e6037-DIC2zPYg.js", "pass-code-skill-chips-to-preload", "      C || S || n\n        ? [\n            {",
    "      C || S || n || claudexReferences\n        ? [\n            {\n              ...(claudexReferences ? { skillReferences: claudexReferences } : {}),"),
  rule(codeStart, "receive-cloud-opening-code-skill-chips", "            initialMessage: a,\n            fileAttachments: o,",
    "            initialMessage: a,\n            skillReferences: claudexReferences,\n            fileAttachments: o,"),
  rule(codeStart, "pass-cloud-opening-code-skill-chips", "              message: yS(a.message, C.ahead),",
    "              message: yS(a.message, C.ahead),\n              skillReferences: claudexRebaseSkillReferences(claudexReferences, a.message.content, yS(a.message, C.ahead).content),"),
  rule(codeStart, "send-cloud-opening-code-skill-event", "        message: e.message,\n        ...(!e.filesAheadUuid",
    "        message: e.message,\n        ...(e.skillReferences ? { skill_references: e.skillReferences } : {}),\n        ...(!e.filesAheadUuid"),
  rule(remoteCode, "receive-cloud-followup-code-skill-chips", "    async send(e, t, n, i, a, o, s, c, l, d, f, p, m, g, v, y, b, x) {",
    "    async send(e, t, n, i, a, o, s, c, l, d, f, p, m, g, v, y, b, x, personSent, limitContinue, claudexReferences) {"),
  rule(remoteCode, "send-cloud-followup-code-skill-event", '            message: { role: "user", content: D, ...(d && d.length > 0 ? { mentions: d } : {}) },',
    '            message: { role: "user", content: D, ...(d && d.length > 0 ? { mentions: d } : {}) },\n            ...(claudexReferences ? { skill_references: claudexRebaseSkillReferences(claudexReferences, t, w) } : {}),'),

  rule(coworkDraft, "receive-opening-cowork-skill-chips", "            rawPrompt: o,\n            humanTypedText: s,",
    "            rawPrompt: o,\n            skillReferences: claudexReferences,\n            humanTypedText: s,"),
  rule(coworkDraft, "pass-opening-cowork-skill-chips", '            message: dt + (Ft ? Cs() : ""),',
    '            message: dt + (Ft ? Cs() : ""),\n            skillReferences: claudexRebaseSkillReferences(claudexReferences, t, dt),'),
  rule("shared-6-abVJ5RR0.js", "send-local-opening-cowork-skill-chips", "              ...B,\n              message: w,\n              sessionId: e.sessionId,",
    "              ...B,\n              message: w,\n              ...(e.skillReferences ? { skillReferences: e.skillReferences } : {}),\n              sessionId: e.sessionId,"),
  rule("shared-160-BGt89-ku.js", "receive-cowork-refs-in-shared-conversation", "                        humanTypedText: i,\n                        artifactViewContext: a,",
    "                        humanTypedText: i,\n                        skillReferences: claudexReferences,\n                        artifactViewContext: a,"),
  rule("shared-160-BGt89-ku.js", "pass-cowork-refs-from-shared-conversation", "                        humanTypedText: i,\n                        input_mode: m,",
    "                        humanTypedText: i,\n                        skillReferences: claudexReferences,\n                        input_mode: m,"),
  rule(coworkPage, "rebase-cowork-skill-chips-for-followup", "                    composerPress: !0,\n                    hasRawPrompt: t.rawPrompt !== void 0,",
    "                    composerPress: !0,\n                    skillReferences: claudexRebaseSkillReferences(t.skillReferences, t.prompt, b),\n                    hasRawPrompt: t.rawPrompt !== void 0,"),
  rule(miniCowork, "rebase-mini-cowork-skill-chips-for-followup", "            composerPress: !0,\n            hasRawPrompt: e.rawPrompt !== void 0,",
    "            composerPress: !0,\n            skillReferences: claudexRebaseSkillReferences(e.skillReferences, e.prompt, l),\n            hasRawPrompt: e.rawPrompt !== void 0,"),
  rule(coworkSession, "send-local-followup-cowork-skill-chips", '                typeof c?.seededSummon == "string" ? c.seededSummon : void 0,\n                e,',
    '                typeof c?.seededSummon == "string" ? c.seededSummon : void 0,\n                c?.skillReferences ? { ...e, skillReferences: c.skillReferences } : e,'),
  rule(coworkSession, "preserve-failed-local-cowork-skill-chips", "                ...Yc(e, t, g),\n                ...pt(",
    "                ...Yc(e, t, g),\n                ...(c?.skillReferences ? { skill_references: c.skillReferences } : {}),\n                ...pt("),
  rule(coworkSession, "preserve-failed-cloud-cowork-skill-chips", "                issued_by_page: is,\n                head_seq_at_send:",
    "                ...(s?.skillReferences ? { skill_references: s.skillReferences } : {}),\n                issued_by_page: is,\n                head_seq_at_send:"),
  rule(coworkSession, "retry-cowork-skill-chips", '    ...(e.is_resend && { isResend: !0 }),',
    '    ...(e.is_resend && { isResend: !0 }),\n    ...(e.skill_references ? { skillReferences: e.skill_references } : {}),'),
  rule(coworkSession, "send-cloud-followup-cowork-skill-chips", "              (await A.current.submitMessage(g, {\n                images:",
    "              (await A.current.submitMessage(g, {\n                skillReferences: s?.skillReferences,\n                images:"),
  rule(coworkSession, "pass-cloud-followup-cowork-skill-chips", "                        H,\n                        void 0,\n                        void 0,\n                      ),",
    "                        H,\n                        void 0,\n                        void 0,\n                        n?.skillReferences,\n                      ),"),
  rule(remoteCowork, "receive-cloud-followup-cowork-skill-chips", "async function Eno(e, t, n, r, i, a, o, s, c, l, u, d, f, p, m, h, g, _, v, y, b) {",
    "async function Eno(e, t, n, r, i, a, o, s, c, l, u, d, f, p, m, h, g, _, v, y, b, claudexReferences) {"),
  rule(remoteCowork, "send-cloud-followup-cowork-skill-event", '        message: { role: "user", content: c && c.length > 0 ? c : hi(n, a) },',
    '        message: { role: "user", content: c && c.length > 0 ? c : hi(n, a) },\n        ...(claudexReferences ? { skill_references: claudexReferences } : {}),'),
];
