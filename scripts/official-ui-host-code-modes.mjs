import fs from "node:fs";
import path from "node:path";

const settings = "c2319015e-DAPw5w9h.js";
const composer = "cc43287c9-BDrqHHqn.js";
const submission = "c6b8adeaf-9EdC4eB_.js";
const localTransport = "cef1e6037-DIC2zPYg.js";
const transcript = "c06cf64bb-CcaN03HG.js";
const resume = "c5cd1b4dc-DhlhtOL0.js";
const terminal = "c6bf19e8f-DOC1qgUM.js";
const events = "shared-m-4-CbJwwS_m.js";
const session = "c5da7eb42-BOzerWAp.js";

function replace(source, before, after, count = 1) {
  if (source.split(before).length !== count + 1)
    throw Error("The original Code mode submission contract changed: " + before);
  return source.replaceAll(before, after);
}

export function deriveOfficialCodeModes(name, source) {
  if (name === settings) {
    source = replace(source,
      "G = Se && d?.disableWorkflows?.value !== !0 && f && (Te || R) && Ee,",
      'G = Se && d?.disableWorkflows?.value !== !0 && f && (Te || R) && Ee && o !== "ssh" && o !== "wsl" && v(h).some(Ga),'
    );
    source = replace(
      source,
      "  let An = J2($, 112, kn, G) ? K2($, 112, kn, G, kn(G) ? G : null) : $[114],",
      `  const storedDraftModel = !t && a === "ssh" && Ge != null && De === "default" ? null : G;
  let An = J2($, 112, kn, storedDraftModel)
      ? K2($, 112, kn, storedDraftModel, kn(storedDraftModel) ? storedDraftModel : null)
      : $[114],`,
    );
    return source + "\nexport const claudexDraftUltracode = () => wa.get(null) === true;\n";
  }
  if (name === submission)
    return replace(source, "  if (t && (Wa.test(e.text) || !Ha())) return null;",
      "  if (t && (Wa.test(e.text) || (e.attachments?.length && !Ha()))) return null;");
  if (name === localTransport)
    return replace(source, "    turnRunning: e.turnRunning,",
      "    turnRunning: e.turnRunning,\n    claudexTurnStartedAt: e.claudexTurnStartedAt,");
  if (name === transcript) {
    source = replace(source, "      armResumedTurn(e) {", "      armResumedTurn(e, startedAt) {");
    source = replace(source,
      "          r = Ch(n);\n        r !== null &&\n          (K.seedFromTail(e, n.slice(r.promptIndex + 1)),",
      `          r = Ch(n);
        const startTime = startedAt ?? r?.startTime;
        startTime !== undefined &&
          (K.seedFromTail(e, r && r.startTime >= startTime ? n.slice(r.promptIndex + 1) : []),`);
    return replace(source, "                startTime: r.startTime,",
      "                startTime: Math.min(startTime, Date.now()),");
  }
  if (name === resume)
    return replace(source, `  let m =
      J1($, 2, s) || J4($, 3, l.length, p, f, c)
        ? I4(
            $,
            3,
            Z1(
              $,
              2,
              () => {
                !s ||
                  c !== "local" ||
                  (f === !0 && !p && l.length > 0
                    ? Q.getState().armResumedTurn(s)
                    : f === !1 && Q.getState().clearMetaArmedTurn(s));
              },
              s,
            ),
            l.length,
            p,
            f,
            c,
          )
        : $[7],
    h = J5($, 8, s, l, p, f, c) ? K5($, 8, s, l, p, f, c, [s, c, f, p, l]) : $[13];
  u(m, h);`, `  const startedAt = r?.claudexTurnStartedAt;
  u(() => {
    if (!s || c !== "local") return;
    if (f === true && !p && (l.length > 0 || startedAt !== undefined))
      Q.getState().armResumedTurn(s, startedAt);
    else if (f === false)
      Q.getState().clearMetaArmedTurn(s);
  }, [s, c, f, p, l, startedAt]);`);
  if (name === terminal) {
    source = replace(source, "function Nr(e, t, n) {", "function Nr(e, t, n, fresh) {");
    source = replace(source,
      "  (ye(t, e === xe && n !== void 0),\n    e === xe\n      ? n === void 0",
      "  (ye(t, e === xe && n !== void 0 && !fresh),\n    e === xe\n      ? fresh || n === void 0");
    return replace(source, "Nr(k, A, e.buffered)", "Nr(k, A, e.buffered, e.fresh)", 2);
  }
  if (name === session)
    return replace(source, "c = a || i ? !0 : !s && void 0;",
      'c = typeof e.external_metadata?.is_ultracode_active === "boolean" ? e.external_metadata.is_ultracode_active : a || i ? !0 : !s && void 0;');
  if (name === composer) {
    source = replace(source, "    await Ea(),\n    u.current?.flushHasText());",
      '    Y.type !== "local" && (await Ea()),\n    u.current?.flushHasText());');
    source = replace(source,
      '      Zi = a || Mt || _ || c || l,',
      `      sshPermissionPending =
        vn === "draft" &&
        Y.envType === "ssh" &&
        Y.startIntent.kind === "local" &&
        Y.startIntent.permissionDefaultPending === !0,
      Zi = a || Mt || _ || c || l || sshPermissionPending,`);
    source = replace(source,
      '      ql = J5($, 407, Xc, Hc, Gc, Zc, qc, Gl, Kl)',
      '      permissionRail = J5($, 407, Xc, Hc, Gc, Zc, qc, Gl, Kl)');
    source = replace(source,
      '        : $[414],\n      Jl = J5($, 415, el, $c, nl, Yc, tl)',
      `        : $[414],
      ql = sshPermissionPending
        ? {
            ...permissionRail,
            loadingLabel: pr.formatMessage({ defaultMessage: "Loading permission options", id: "XgNUAv" }),
          }
        : permissionRail,
      Jl = J5($, 415, el, $c, nl, Yc, tl)`);
    source = replace(source,
      '        modeValue: f,\n        manualWarning: p,\n        manualTooltip: m,\n        inBar: h,\n      } = e,\n      g = Wf(),',
      `        modeValue,
        manualWarning: p,
        manualTooltip: m,
        inBar: h,
      } = e,
      g = Wf(),
      f = c.loadingLabel ?? modeValue,`);
    source = replace(source,
      '                  checked: e.id === c.mode,',
      '                  checked: !c.loadingLabel && e.id === c.mode,');
    source = replace(source,
      '} from "./c2319015e-DAPw5w9h.js";',
      '} from "./c2319015e-DAPw5w9h.js";\nimport { claudexDraftUltracode } from "./c2319015e-DAPw5w9h.js";');
    source = replace(source,
      'Me = W ? [qi(W.id)] : void 0;\n              switch (p.kind)',
      'Me = W ? [qi(W.id)] : void 0;\n              const draftUltracode = claudexDraftUltracode();\n              switch (p.kind)');
    source = replace(source, 'fastMode: y.fastMode,',
      'fastMode: y.fastMode,\n                        ...(draftUltracode && { ultracode: true }),');
    return replace(source, 'fastMode: p.fastMode,',
      'fastMode: p.fastMode,\n                      ...(draftUltracode && { ultracode: true }),', 2);
  }
  if (name === events) {
    source = replace(source, 'fastMode: c,\n            firstMessageKeepalive: l,',
      'fastMode: c,\n            ultracode: draftUltracode,\n            firstMessageKeepalive: l,');
    source = replace(source, 'fastMode: c,\n              keepalive: l,',
      'fastMode: c,\n              ultracode: draftUltracode,\n              keepalive: l,');
    source = replace(source, '...(e.effortLevel\n      ? [\n          {\n            payload: {\n              type: "control_request",\n              request_id: `set-effort-',
      '...(e.effortLevel || e.ultracode === true\n      ? [\n          {\n            payload: {\n              type: "control_request",\n              request_id: `set-effort-');
    source = replace(source, 'request: { subtype: "apply_flag_settings", settings: { effortLevel: e.effortLevel } },',
      'request: { subtype: "apply_flag_settings", settings: { ...(e.effortLevel && { effortLevel: e.effortLevel }), ...(e.ultracode === true && { ultracode: true }) } },');
    return replace(source, 'function fE(e) {\n  return e.permissionMode === void 0;',
      'function fE(e) {\n  return e.permissionMode === void 0 && e.ultracode !== true;');
  }
  return source;
}

export function applyOfficialCodeModes(directory) {
  for (const name of [settings, composer, submission, localTransport, transcript, resume, terminal, events, session]) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, deriveOfficialCodeModes(name, fs.readFileSync(file, "utf8")));
  }
  return true;
}
