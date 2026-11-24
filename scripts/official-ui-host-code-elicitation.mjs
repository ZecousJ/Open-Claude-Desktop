import fs from "node:fs";
import path from "node:path";

export const hostCodeElicitationRevision = "local-code-mcp-elicitation-v5";

const permissionProjection = `function LP(e, t) {
  return {
    sessionId: e,
    requestId: t.requestId,
    toolUseId: t.requestId,
    cliToolUseId: t.cliToolUseId,
    connectorCall: t.connectorCall,
    toolName: t.toolName,
    input: pJ(t.input),
    transport: "ipc",`;
const ipcDecision = `              n = nb()?.(C.sessionId, C.requestId, t, e);`;
const nativeReply = `        o.setRequestStatus(n, r, "resolving");
        let u = e.respondToToolPermission(r, l, i);
        return (
          o.resolveRequest(n, r, l, i),`;

const changes = {
  "c03be4f3b-COcLjXuL.js": [[
    `function jr(e) {
  let t = Pt();
  return L(Ee, e && t);
}`,
    `function jr(e) {
  let t = Pt();
  const enabled = L(Ee, e && t);
  const host = window.__claudexOfficialAccountContext ?? window["claude.web"];
  return enabled || !!(e && host);
}`,
  ], [
    "          n = Ut.filter(t),\n          r = new Map(Ut.map(Ba));",
    `          servedCowork = new Set(H.rows.filter(row => row.ref.kind === "cowork").map(row => row.ref.id)),
          n = Ut.filter(row => t(row) && !servedCowork.has(row.ref.id)),
          r = new Map(Ut.map(Ba));`,
  ]],
  "shared-39-BVbIfnmZ.js": [
    [permissionProjection, `${permissionProjection}
    ...(t.isElicitation === !0 ? {
      isElicitation: !0,
      elicitationServerName: t.toolName,
      elicitationForm: t.elicitationForm,
      elicitationLink: t.elicitationLink,
    } : {}),`],
    [nativeReply, `        s?.isElicitation !== !0 && o.setRequestStatus(n, r, "resolving");
        let u = e.respondToToolPermission(r, l, i);
        return (
          s?.isElicitation !== !0 && o.resolveRequest(n, r, l, i),`],
  ],
  "c5da7eb42-BOzerWAp.js": [
    [ipcDecision, `              n = nb()?.(C.sessionId, C.requestId,
                (C.elicitationForm ?? C.elicitationLink) === void 0 ? t : Yv(D, r?.formResult), e);`],
  ],
  "shared-3-f8anTwq9.js": [[
    `    transport: "ipc",
    suggestions: e.suppressAlwaysAllowRule === !0 ? void 0 : e.suggestions,`,
    `    transport: "ipc",
    ...(e.isElicitation === !0 ? {
      isElicitation: !0,
      elicitationServerName: e.toolName,
      elicitationForm: e.elicitationForm,
      elicitationLink: e.elicitationLink,
    } : {}),
    suggestions: e.suppressAlwaysAllowRule === !0 ? void 0 : e.suggestions,`,
  ]],
  "cc32965c2-BNok1Xiq.js": [[
    `export { ac as a, Ns as c, lc as i, Ec as n, dc as o, cc as r, Ms as s, Vb as t };`,
    `export { ac as a, Ns as c, lc as i, Ec as n, dc as o, cc as r, Ms as s, Vb as t, nc as claudexElicitationForm, ic as claudexElicitationLink };`,
  ], [
    `  return J3($, 78, s, re, fe)`,
    `  const approval = g.properties?.decision;
  const choices = approval?.enum;
  const onceOnly = choices?.length === 1 && choices[0] === "once";
  const website = choices?.length === 2 && choices[0] === "once" && choices[1] === "always" &&
    approval.enumNames?.[1] === "Always allow for this website";
  if (a.fieldNames.length === 1 && a.fieldNames[0] === "decision" &&
      approval?.type === "string" && (onceOnly || website)) {
    const name = approval.enumNames?.[0] ?? "Allow once";
    const label = name === "Run workflow" && c.locale.startsWith("zh") ? "运行工作流"
      : name === "Allow once" ? c.formatMessage({ defaultMessage: "Allow once", id: "O2tb5K" })
      : name === "Allow" ? c.formatMessage({ defaultMessage: "Allow", id: "y/bmsG8rnv" }) : name;
    const button = (decision, text, variant) => m(E, {
      type: "button", variant, busy: ce, disabled: ie,
      onClick: () => T({ action: "accept", content: { decision } }),
      children: text,
    });
    const allow = button("once", label, "primary");
    const always = website && button("always", c.formatMessage({
      defaultMessage: "Always allow for this website", id: "IqIbyB",
    }), "secondary");
    return i(Qo, {
      queueDepth: s,
      onKeyDown: tc,
      children: [m(ns, { children: M }), i("div", {
        className: "epitaxy-approval-actions flex flex-wrap justify-end gap-x-md gap-y-sm " + rs,
        children: [se, always, m(mt, { armKey: t, children: allow })],
      })],
    });
  }
  return J3($, 78, s, re, fe)`,
  ]],
  "c73f45bc3-DPTYBg79.js": [[
    `        ...uv(T || D || d.has("plan"), {
          icon: na.plan,
          label: i.formatMessage({ defaultMessage: "Plan", id: "/7CA0v" }),
          checked: d.has("plan"),
          checkedRole: "checkbox",
          onSelect: r,
        }),
`,
    "",
  ]],
  "ca44d5dae-Duwp3Ivb.js": [[
    `import { vL as e } from "./rolldown-runtime-BmbMa3VH.js";`,
    `import { claudexElicitationForm, claudexElicitationLink } from "./cc32965c2-BNok1Xiq.js";
import { vL as e } from "./rolldown-runtime-BmbMa3VH.js";`,
  ], [
    `    Zr = function (t, n) {`,
    `    const claudexRespond = n;
    Zr = function (t, n) {`,
  ], [
    `      if (e.connectAsk !== void 0)
        return S(`,
    `      if (e.transport === "ipc" && e.isElicitation === !0 &&
          (e.elicitationForm !== void 0 || e.elicitationLink !== void 0)) {
        const ask = e.elicitationForm ?? e.elicitationLink;
        const component = e.elicitationForm !== void 0 ? claudexElicitationForm : claudexElicitationLink;
        const decide = (decision, _input, details) => {
          if (!claudexRespond || !details?.formResult) return;
          return Promise.resolve().then(() => claudexRespond(e.toolUseId, e.toolUseId, details.formResult, decision)).then(
            () => details.onAnswered?.(!0),
            () => details.onAnswered?.(!1),
          );
        };
        return S(component, { armKey: e.toolUseId, serverName: e.toolName, ask, decide }, e.toolUseId);
      }
      if (e.connectAsk !== void 0)
        return S(`,
  ]],
};

export const hostCodeElicitationFiles = Object.keys(changes);

export function deriveOfficialUiHostCodeElicitationModule(file, source) {
  if (!Object.hasOwn(changes, file)) return source;
  for (const [before, after] of changes[file]) {
    if (source.split(before).length !== 2)
      throw Error("Native Code elicitation anchor mismatch: " + file);
    source = source.replace(before, after);
  }
  return source;
}

export function applyOfficialUiHostCodeElicitation(directory) {
  for (const name of hostCodeElicitationFiles) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, deriveOfficialUiHostCodeElicitationModule(name, fs.readFileSync(file, "utf8")));
  }
  return { revision: hostCodeElicitationRevision };
}
