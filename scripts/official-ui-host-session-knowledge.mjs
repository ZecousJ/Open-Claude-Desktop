import fs from "node:fs";
import path from "node:path";

const composer = "shared-6-abVJ5RR0.js";
const codeMenu = "ca80fca8d-LvEosFmV.js";
const codeStart = "cc43287c9-BDrqHHqn.js";
const coworkMenu = "c752b32f8-CkH0gFtn.js";
const coworkSession = "cb1e253a0-D3VA46OS.js";
const coworkApi = "shared-2-CuvP2TaI.js";

export const sessionKnowledgeRevision = "session-knowledge-v1";

const imports = 'import { __claudexKnowledgeChoice, __claudexKnowledgeStore, __claudexKnowledgeUuid, __claudexKnowledgeDraftTools } from "./' + composer + '";\n';
const rules = {
  [composer]: [
    ['function pN(e) {', `export const __claudexKnowledgeUuid = "249127a3-bfaf-41c8-8d23-2992099f8949";
export const __claudexKnowledgeStore = Lv((set) => ({
  choices: {},
  write(account, mode, session, choice) {
    if (!account) return;
    const key = JSON.stringify([account, mode, session ?? null]);
    set(state => ({ choices: { ...state.choices, [key]: choice } }));
  },
}));
export function __claudexKnowledgeChoice(state, account, mode, session) {
  return state.choices[JSON.stringify([account, mode, session ?? null])];
}
export function __claudexKnowledgeDraftTools(choice, tools) {
  if (choice !== true) return tools;
  const prefix = __claudexKnowledgeUuid + ":";
  return { ...tools, [prefix + "rag_search"]: true, [prefix + "rag_read"]: true };
}
function pN(e) {`],
    ['  let n = Object.entries(t ?? {}).filter(([, e]) => !e);\n  return n.length === 0 ? e : { ...e, ...Object.fromEntries(n) };', `  let n = Object.entries(t ?? {}).filter(([key, enabled]) =>
    !enabled && (!__claudexKnowledgeToolKey(key) || e?.[key] === undefined),
  );
  return n.length === 0 ? e : { ...e, ...Object.fromEntries(n) };`],
    ['function Mz(e, t) {\n  return e.length > 0 && e.every((e) => t?.[e] === !1);\n}', `function __claudexKnowledgeToolKey(key) {
  return key === __claudexKnowledgeUuid + ":rag_search" || key === __claudexKnowledgeUuid + ":rag_read";
}
function Mz(e, t) {
  return e.length > 0 && e.every((e) => !__claudexKnowledgeToolKey(e) && t?.[e] === !1);
}`],
    ['          let N = e.tClick ?? performance.now(),\n            P = Yw();', `          const hostedKnowledgeAccount = window.__claudexOfficialAccountContext?.accountUuid;
          const requestedKnowledge = e.message === void 0 ? void 0 :
            __claudexKnowledgeChoice(__claudexKnowledgeStore.getState(), hostedKnowledgeAccount, "cowork", null);
          let N = e.tClick ?? performance.now(),
            P = Yw();`],
    ['            X = J ? void 0 : HG(g ? q : q !== !1 && void 0),', `            X = requestedKnowledge === true
              ? { ...(J ? void 0 : HG(g ? q : q !== !1 && void 0)), knowledge_huaner_tech: true }
              : J ? void 0 : HG(g ? q : q !== !1 && void 0),`],
    ['          let re = ne ? null : By(),', '          let re = ne || requestedKnowledge === true ? null : By(),'],
    ['                  mq(n.sessionId, Ne, X, f, n.sentBridgeToolsKey),', `                  requestedKnowledge === true && __claudexKnowledgeStore.getState().write(hostedKnowledgeAccount, "cowork", null, void 0),
                  mq(n.sessionId, Ne, X, f, n.sentBridgeToolsKey),`],
    ['                enabledMcpTools: R ? void 0 : (e.enabledMcpTools ?? A),', `                enabledMcpTools: R ? void 0 : __claudexKnowledgeDraftTools(
                  e.scheduledTaskId ? void 0 : __claudexKnowledgeChoice(__claudexKnowledgeStore.getState(), t.account?.uuid, "cowork", null),
                  e.enabledMcpTools ?? A,
                ),`],
    ['          if (ee?.sessionId) {\n            if ((e.trailingContentBlocks', `          if (ee?.sessionId) {
            if (!e.scheduledTaskId) __claudexKnowledgeStore.getState().write(t.account?.uuid, "cowork", null, void 0);
            if ((e.trailingContentBlocks`],
  ],
  [codeMenu]: [
    ['import { Y6 as Ce } from "./' + composer + '";', imports + 'import { Y6 as Ce } from "./' + composer + '";'],
    ['function Qr(e) {\n  let $ = J9(194),', 'function Qr(e) {\n  let $ = J9(197),'],
    ['    N = oe?.settings?.enabled_mcp_tools,', `    N = oe?.settings?.enabled_mcp_tools,
    knowledgeDraft = __claudexKnowledgeStore(state => __claudexKnowledgeChoice(state, oe?.uuid, "code", null)),`],
    ['    Te = J1($, 8, we)', `    knowledgeOnSession = ht(state =>
      r?.type === "local" ? state.sessions.find(session => session.sessionId === we)?.claudexKnowledgeEnabled : void 0
    ),
    Te = J1($, 8, we)`],
    ['    Be = J5($, 19, N, be, de, pe, F, r, Se)', '    Be = $[196] !== oe?.uuid || J5($, 19, N, be, de, pe, F, r, Se)'],
    ['? K5($, 19, N, be, de, pe, F, r, Se, (e, t, n) => {\n          let i = {};', `? (($[196] = oe?.uuid), K5($, 19, N, be, de, pe, F, r, Se, (e, t, n) => {
          if (e.uuid === __claudexKnowledgeUuid && !r) {
            __claudexKnowledgeStore.getState().write(oe?.uuid, "code", null, n);
            return;
          }
          let i = {};`],
    ['              : be && Se(e, n));\n        })\n      : $[26],', '              : be && Se(e, n));\n        }))\n      : $[26],'],
    ['(Object.keys(a).length > 0 && de({ enabled_mcp_tools: a }),', '(e.uuid !== __claudexKnowledgeUuid && Object.keys(a).length > 0 && de({ enabled_mcp_tools: a }),'],
    ['      $[193] !== __claudexDisabledMcp ||', '      $[193] !== __claudexDisabledMcp || $[194] !== knowledgeDraft || $[195] !== knowledgeOnSession ||'],
    ['        let s = xe(e) ?? (', '        let s = e.uuid === __claudexKnowledgeUuid\n          ? (we ? (xe(e) ?? knowledgeOnSession) === true : knowledgeDraft === true)\n          : xe(e) ?? ('],
    ['        ($[193] = __claudexDisabledMcp),', '        ($[193] = __claudexDisabledMcp),\n        ($[194] = knowledgeDraft),\n        ($[195] = knowledgeOnSession),'],
  ],
  [codeStart]: [
    ['import { T as Zb, d as Qb, v as $b, x as ex }', imports + 'import { T as Zb, d as Qb, v as $b, x as ex }'],
    ['              let {\n                intent: p,\n                movesAtSubmit: S,', `              const openingAccount = e?.uuid;
              const openingMcp = { enabledMcpTools: b, enabledExtensionIds: x, ensureToolsReady: w };
              const knowledgeDraft = __claudexKnowledgeChoice(__claudexKnowledgeStore.getState(), openingAccount, "code", null);
              let {
                intent: p,
                movesAtSubmit: S,`],
    ['Ju({ enabledMcpTools: b, enabledExtensionIds: x, ensureToolsReady: w }),', 'Ju({ enabledMcpTools: __claudexKnowledgeDraftTools(knowledgeDraft, b), enabledExtensionIds: x, ensureToolsReady: w }),'],
    ['                        enabledMcpTools: d.enabledMcpTools,\n                        attachments: V,', '                        enabledMcpTools: __claudexKnowledgeDraftTools(knowledgeDraft, d.enabledMcpTools),\n                        attachments: V,'],
    ['                  (ee !== void 0 && Is(S, ee),', `                  __claudexKnowledgeStore.getState().write(openingAccount, "code", null, void 0);
                  (ee !== void 0 && Is(S, ee),`],
    ['                    o = {\n                      ...QV(p, U, W?.id, G),', `                    knowledge = knowledgeDraft === true ? (await Ju({
                      ...openingMcp,
                      enabledMcpTools: __claudexKnowledgeDraftTools(true, openingMcp.enabledMcpTools),
                    })).remoteMcpServers.find(server => server.uuid === __claudexKnowledgeUuid) : void 0,
                    o = {
                      ...QV(p, U, W?.id, G),
                      ...(knowledge?.url && { mcpConfig: { mcpServers: {
                        [knowledge.uuid]: { type: "http", url: knowledge.url, headers: { "X-MCP-Server-ID": knowledge.uuid } },
                      } } }),`],
    ['                      if (!k) return null;\n                      if (r) return (k.discard("mismatch", "attachments"), null);', '                      if (!k) return null;\n                      if (knowledge) return (k.discard("mismatch", "connectors"), null);\n                      if (r) return (k.discard("mismatch", "attachments"), null);'],
    ['                  if (i || n.discarded())\n                    throw Error(`${Ab} ${S.id} discarded before its first message`);', '                  if (i || n.discarded())\n                    throw Error(`${Ab} ${S.id} discarded before its first message`);\n                  __claudexKnowledgeStore.getState().write(openingAccount, "code", null, void 0);'],
  ],
  [coworkMenu]: [
    ['function no(t, n) {\n  let $ = J9(60),', imports + 'function no(t, n) {\n  let $ = J9(66),'],
    ['    { conversation: i, isLocalAgentRoute: a, isAgentMode: o } = Ye(),', '    { conversation: i, isLocalAgentRoute: a, isAgentMode: o, isAgentNewRoute: knowledgeNew, isRemoteCoworkSession: knowledgeRemote, localSessionId: knowledgeLocalId } = Ye(),'],
    ['    { account: A } = Qe(),\n    j = Ue("enabled_mcp_tools"),', `    { account: A, activeOrganization: knowledgeOrg } = Qe(),
    knowledgeAccountUuid = A?.uuid,
    hostedCowork = !!knowledgeAccountUuid && window.__claudexOfficialAccountContext?.accountUuid === knowledgeAccountUuid && knowledgeRemote,
    knowledgeSessionId = hostedCowork ? (i?.sessionId ?? knowledgeLocalId ?? f) : void 0,
    knowledgeChoice = __claudexKnowledgeStore(state =>
      __claudexKnowledgeChoice(state, knowledgeAccountUuid, "cowork", knowledgeSessionId)
    ),
    j = Ue("enabled_mcp_tools"),`],
    ['J5($, 10, M, F, B, U, P, c) ||', 'J5($, 60, knowledgeChoice, knowledgeSessionId, knowledgeAccountUuid, knowledgeNew, hostedCowork) || J5($, 10, M, F, B, U, P, c) ||'],
    ['K5($, 10, M, F, B, U, P, c),', 'K5($, 60, knowledgeChoice, knowledgeSessionId, knowledgeAccountUuid, knowledgeNew, hostedCowork, void 0), K5($, 10, M, F, B, U, P, c),'],
    ['      let B = t?.isConnectorEnabled(i) ?? $n(i, j, z, !1),', `      const managed = i.uuid === __claudexKnowledgeUuid;
      const managedCowork = managed && (o || knowledgeNew || knowledgeRemote);
      let B = managedCowork && (knowledgeNew || hostedCowork)
          ? knowledgeChoice === true
          : t?.isConnectorEnabled(i) ?? $n(i, j, z, !1),`],
    ['              let e = !B;\n              if ((re(v, e, i.url), t?.onAfterToggle(i, e), f && m)) {', `              let e = !B;
              if (managedCowork && knowledgeNew) {
                __claudexKnowledgeStore.getState().write(knowledgeAccountUuid, "cowork", null, e);
                return;
              }
              if (managedCowork && hostedCowork && knowledgeSessionId && knowledgeOrg?.uuid) {
                w(state => ({ ...state, [i.uuid]: e }));
                fetch("/api/organizations/" + knowledgeOrg.uuid + "/cowork/sessions/" + encodeURIComponent(knowledgeSessionId) + "/mcp-servers", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ builtin_servers: { knowledge_huaner_tech: e } }),
                }).then(response => {
                  if (response.ok) __claudexKnowledgeStore.getState().write(knowledgeAccountUuid, "cowork", knowledgeSessionId, e);
                }).finally(() => w(state => Object.fromEntries(Object.entries(state).filter(([id]) => id !== i.uuid)))).catch(() => {});
                return;
              }
              if (((!managedCowork && re(v, e, i.url)), t?.onAfterToggle(i, e), f && m)) {`],
    ['                  coworkSnapshotSync: y,', '                  coworkSnapshotSync: managedCowork ? false : y,'],
  ],
  [coworkSession]: [
    ['function hx(e) {', imports + 'function hx(e) {'],
    ['    { events: F, streaming: ie, session: I, error: L, headSeq: R, olderCursor: ae } = P,\n    z =', `    { events: F, streaming: ie, session: I, error: L, headSeq: R, olderCursor: ae } = P,
    knowledgeAccount = window.__claudexOfficialAccountContext?.accountUuid,
    z =`],
    ['  (J3($, 31, R, _, B)', `  m(() => {
    if (typeof I?.claudexKnowledgeEnabled === "boolean")
      __claudexKnowledgeStore.getState().write(knowledgeAccount, "cowork", t, I.claudexKnowledgeEnabled);
  }, [knowledgeAccount, t, I?.claudexKnowledgeEnabled]);
  (J3($, 31, R, _, B)`],
  ],
  [coworkApi]: [
    ['    model: r.config?.model ?? void 0,\n    permissionMode:', '    model: r.config?.model ?? void 0,\n    claudexKnowledgeEnabled: r.claudex_knowledge_enabled,\n    permissionMode:'],
  ],
};

export const sessionKnowledgeFiles = Object.keys(rules);

export function deriveSessionKnowledge(file, source) {
  for (const [before, after] of rules[file] ?? []) {
    if (source.split(before).length !== 2)
      throw Error("Session knowledge anchor mismatch: " + file + ": " + before);
    source = source.replace(before, after);
  }
  return source;
}

export function applySessionKnowledge(directory) {
  for (const file of sessionKnowledgeFiles) {
    const target = path.join(directory, file);
    fs.writeFileSync(target, deriveSessionKnowledge(file, fs.readFileSync(target, "utf8")));
  }
  return sessionKnowledgeRevision;
}
