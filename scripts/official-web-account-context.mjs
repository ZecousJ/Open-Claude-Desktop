const officialImageHook = (useState, useEffect) => `function __claudexUseChatImage(source) {
  const path = window.__claudexOfficialChatImagePath?.(source);
  const [asset, setAsset] = ${useState}(void 0);
  ${useEffect}(() => {
    if (!path) return;
    const request = new AbortController();
    let objectUrl;
    void window.fetch(path, { signal: request.signal }).then(async response => {
      if (!response.ok || !/^image\\/(png|jpeg|gif|webp)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return;
      const blob = await response.blob();
      if (request.signal.aborted || !blob.size) return;
      objectUrl = URL.createObjectURL(blob);
      setAsset({ path, url: objectUrl });
    }).catch(() => {});
    return () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return path ? (asset?.path === path ? asset.url : void 0) : source;
}`;

const rules = {
  "assets/v1/cd27cb2c4-B85UNfrR.js": [
    [
      '_ = n ? new WebSocket(t, [V, `${H}${n.ticket}`]) : new WebSocket(t);',
      [
        '_ = n ? new WebSocket(t, [V, `${H}${n.ticket}`])',
        '            : window.__claudexOfficialDictation',
        '              ? window.__claudexOfficialDictation.open(t)',
        '              : new WebSocket(t);',
      ].join("\n"),
    ],
    [
      'this.maxDurationMs = je(e?.maxSeconds);',
      'this.maxDurationMs = window.__claudexOfficialDictation?.recordingMillis() ?? je(e?.maxSeconds);',
    ],
    [
      's ? Ee : Ce + c,',
      's ? Ee : (window.__claudexOfficialDictation?.drainMillis ?? Ce) + c,',
    ],
  ],
  "assets/v1/shared-m-8-CVxtIISM.js": [[
    '  if (!("Notification" in window)) return { success: !1, errorSource: "browser_or_permissions" };',
    `  const requestBrowserPermission = window.__claudexOfficialAccountContext?.requestNotificationPermission;
  if (requestBrowserPermission) {
    if (i || !navigator.userActivation.isActive) return { success: !1, errorSource: "unavailable" };
    const permission = await requestBrowserPermission();
    if (permission === "granted") return { success: !0 };
    if (permission === "unavailable") return { success: !1, errorSource: "unavailable" };
    return { success: !1, errorSource: "browser_or_permissions", permission };
  }
  if (!("Notification" in window)) return { success: !1, errorSource: "browser_or_permissions" };`,
  ]],
  "assets/v1/c0db37792-DkdHyU30.js": [
    ['t = Q("routines", "enable_push"),', 't = nr(Q("routines", "enable_push")),'],
    ['n = Q("code_requires_action", "enable_push");', 'n = nr(Q("code_requires_action", "enable_push"));'],
  ],
  "assets/v1/c79197f2b-BdxpRmPT.js": [
    ["{ enabled: !0, forRemoval: u }", "{ enabled: !0, forRemoval: !0 }"],
    ["K1($, 0, u, { enabled: u })", "K1($, 0, u, { enabled: u, forRemoval: !0 })"],
  ],
  "assets/v1/c71860c77-pnODXvGc.js": [
    [
      '        e.is_current ? (Le("single", null), f.push("/logout")) : (n(), o(!1));',
      `        if (!e.is_current) return (n(), o(!1));
        const accountHost = window.__claudexOfficialAccountContext;
        if (accountHost) {
          accountHost.signOutCurrentSession();
          o(!1);
        } else (Le("single", null), f.push("/logout"));`,
    ],
    [
      '                    !d || !l() || (r.push("/logout/all-sessions"), Vt(), n(!1));',
      `                    if (!d || !l()) return;
                    const accountHost = window.__claudexOfficialAccountContext;
                    if (accountHost) accountHost.revokeAllSessions();
                    else (r.push("/logout/all-sessions"), Vt());
                    n(!1);`,
    ],
  ],
  "assets/v1/shared-19-DSOWNXOA.js": [
    [
      'function Dm(e) {\n  return Z_("single", e);\n}',
      `function Dm(e) {
  const accountHost = window.__claudexOfficialAccountContext;
  if (!accountHost) return Z_("single", e);
  e.preventDefault();
  accountHost.signOutCurrentSession();
}`,
    ],
  ],
  "assets/v1/shared-7-D_yzHgAj.js": [
    [
      '    s = f2();\n  return (\n    i &&\n    !a &&\n    ((r && s) || (!r && n && ((e === "code" && !o && t) || e === "chat" || e === "cowork")))\n  );',
      `    s = f2(), host = window.__claudexOfficialDictation;
  const [available, setAvailable] = Zt(() => host?.getSnapshot() ?? false);
  jX(() => {
    if (!host) return;
    const update = () => setAvailable(host.getSnapshot());
    const off = host.subscribe(update);
    update();
    return off;
  }, [host]);
  const area = (e === "code" && !o && t) || e === "chat" || e === "cowork";
  return i && !a && (host ? available && area : (r && s) || (!r && n && area));`,
    ],
    [
      '  return BG() && e && t !== !0 && n;',
      '  return !window.__claudexOfficialDictation && BG() && e && t !== !0 && n;',
    ],
    [
      "function Bs(e) {\n  let $ = J9(60),",
      `${officialImageHook("Zt", "jX")}
function Bs(e) {
  let $ = J9(60),`,
    ],
    [
      `  if (!w) return null;
  let F = t ? t.preview_asset.url : n,
    I = t ? t.preview_asset.image_width : i,`,
      `  const source = t ? t.preview_asset.url : n;
  const F = __claudexUseChatImage(w ? source : void 0);
  if (!w) return null;
  let I = t ? t.preview_asset.image_width : i,`,
    ],
    ["  if (!F && !s) return null;\n  let B =", "  if (!source && !s) return null;\n  let B ="],
    ["    y = g ? _ : v?.url,", "    y = __claudexUseChatImage(g ? _ : v?.url),"],
  ],
  "assets/v1/shared-80-BHdgCDlr.js": [
    [
      "function b5(e, t) {",
      `${officialImageHook("_v", "Gw")}\nfunction b5(e, t) {`,
    ],
    [
      "    if (_ !== void 0) {\n      let e = J1($, 17, l)",
      "    const imageSource = __claudexUseChatImage(_);\n    if (_ !== void 0) {\n      let e = J1($, 17, l)",
    ],
    [
      `      return J5($, 23, h, p, g, _, m, e, n)
        ? K5(
            $,
            23,
            h,
            p,
            g,
            _,
            m,
            e,
            n,
            gl(Ki.Image, { src: _, ...e, alt: n, onClick: p, state: m, ...h, ...g }),`,
      `      return J5($, 23, h, p, g, imageSource, m, e, n)
        ? K5(
            $,
            23,
            h,
            p,
            g,
            imageSource,
            m,
            e,
            n,
            gl(Ki.Image, { src: imageSource, ...e, alt: n, onClick: p, state: m, ...h, ...g }),`,
    ],
  ],
  "assets/v1/shared-m-1-Nm0kn4Ee.js": [[
    `function pC(e, t, n) {
  let { signal: r, headers: i, onUploadProgress: a, onUploadSettled: o } = n;
  return new Promise`,
    `function pC(e, t, n) {
  let { signal: r, headers: i, onUploadProgress: a, onUploadSettled: o } = n;
  let sent = 0, total = 0, last = performance.now();
  const bridged = window.__claudexOfficialChatUpload?.(e, t, {
    signal: r,
    onProgress: (loaded, length) => {
      sent = loaded;
      total = length;
      last = performance.now();
      a(loaded, length);
    },
  });
  if (bridged) return bridged.catch(error => {
    try { o?.({ sentBand: g4(sent, total, total > 0 && sent === total), idleMs: performance.now() - last }); }
    catch {}
    throw error;
  });
  return new Promise`,
  ], [
    `function RP(e) {
  return {
    skillId: e.id,
    skillName: e.name,`,
    `function RP(e) {
  const installed = e.viewer?.installed;
  return {
    ...(installed?.claudex_read_only === true && {
      claudexReadOnly: true,
      claudexCanEditContents: installed.claudex_can_edit_contents === true,
      claudexCanRenameDuplicate: installed.claudex_can_rename_duplicate === true,
      canEdit: installed.can_edit,
      canRemove: installed.can_remove,
      canToggle: installed.can_toggle,
      displayName: e.display_name ?? null,
    }),
    skillId: e.id,
    skillName: e.name,`,
  ], [
    '    source: e.source ?? null,\n    isShared: e.is_shared ?? !1,',
    '    source: installed?.claudex_read_only === true && e.source === "user" ? "custom" : e.source ?? null,\n    isShared: e.is_shared ?? !1,',
  ], [
    `        can_toggle: !0,
        can_remove: e.canRemove ?? r !== "organization",
        can_edit: t ? MR(e) : _W(e),`,
    `        ...(e.claudexReadOnly === true && {
          claudex_read_only: true,
          claudex_can_edit_contents: e.claudexCanEditContents === true,
          claudex_can_rename_duplicate: e.claudexCanRenameDuplicate === true,
        }),
        can_toggle: e.claudexReadOnly === true ? e.canToggle === true : !0,
        can_remove: e.canRemove ?? r !== "organization",
        can_edit: t ? MR(e) : _W(e),`,
  ]],
  "assets/v1/c2e144342-BPmQtTD1.js": [
    [
      "    canEdit: e.viewer.installed?.can_edit ?? void 0,",
      "    claudexCanRenameDuplicate: e.viewer.installed?.claudex_can_rename_duplicate === true,\n    canEdit: e.viewer.installed?.can_edit ?? void 0,",
    ],
  ],
  "assets/v1/cfaabd194-B0CE4rOW.js": [
    [
      "    let s = le(r) || se(r),",
      "    let s = r.claudexCanRenameDuplicate === true || le(r) || se(r),",
    ],
    [
      "    C = nt(),\n    w = et(),",
      `    C = nt(),
    __claudexWebSkill = typeof window !== "undefined" && window.__claudexOfficialAccountContext,
    __claudexCanRemove = __claudexWebSkill && t.canRemove === true,
    w = et(),`,
    ],
    [
      "    ((P = e === null), (F = e === null ? null : Jt(v, e)), K3($, 5, v, t, P, F));",
      "    ((P = e === null && (!__claudexWebSkill || __claudexCanRemove)), (F = e === null ? null : Jt(v, e)), K3($, 5, v, t, P, F));",
    ],
    [
      "z && ce && (N || se(t)) && !!u",
      `z && ce && !!u && (typeof window !== "undefined" && window.__claudexOfficialAccountContext
        ? t.claudexCanRenameDuplicate === true : N || se(t))`,
    ],
    [
      "    ke = !C || !ye,",
      "    ke = !ye || (!C && !(t.claudexCanRenameDuplicate === true && (ue || fe)) && !(__claudexCanRemove && he)),",
    ],
    [
      '    D = ne("skill_creation").isAvailable,',
      `    __claudexSkillCreation = ne("skill_creation").isAvailable,
    __claudexWebSkill = typeof window !== "undefined" && window.__claudexOfficialAccountContext,
    __claudexCanRenameDuplicate = e?.claudexCanRenameDuplicate === true,
    D = __claudexWebSkill ? __claudexCanRenameDuplicate : __claudexSkillCreation,`,
    ],
    [
      "    Nt = J2($, 75, jt, e) ? K2($, 75, jt, e, jt || (!!e && se(e))) : $[77],",
      `    Nt = J2($, 75, jt, e)
      ? K2($, 75, jt, e, __claudexWebSkill ? __claudexCanRenameDuplicate : jt || (!!e && se(e)))
      : $[77],`,
    ],
  ],
  "assets/v1/c979ed9d0-C-llIJ0y.js": [
    [
      "      r = n.removeAvailable && e === null;",
      `      r = e === null && (typeof window !== "undefined" && window.__claudexOfficialAccountContext
        ? t.canRemove === true : n.removeAvailable);`,
    ],
  ],
  "assets/v1/ca66f3eeb-C4UiY65l.js": [
    [
      `  let i = \`session-\${e}-\${t}\`,`,
      `  const hosted = window.__claudexOfficialAccountContext;
  if (hosted) {
    const { base, hash } = oe(r);
    return hosted.codePreviewUrl(n, base + hash) ?? "";
  }
  let i = \`session-\${e}-\${t}\`,`,
    ],
  ],
  "assets/v1/c73f45bc3-DPTYBg79.js": [
    [
      `    r || (i && a) || o || s || (e?.type === "landing" && c) || (n?.type === "remote" && (l || c))`,
      `    r || (i && a) || o || s || (e?.type === "landing" && c) ||
    (n?.type === "remote" && (l || c || window.__claudexOfficialAccountContext?.codePreviewAvailable === true))`,
    ],
  ],
  "assets/v1/cbd6c85c8-VtqGtXN9.js": [
    [
      "  cn as ve,",
      "  cn as ve,\n  __claudexWebCodeNavigation,",
    ],
    [
      "    t = fe(Dt),\n    r = e || t,",
      "    t = fe(Dt),\n    auth = ke(),\n    r = e || t || __claudexWebCodeNavigation(auth),",
    ],
  ],
  "assets/v1/c9500abe8-CRS6YI1t.js": [
    [
      "  cn as me,\n  eA as be,",
      "  cn as me,\n  __claudexWebCodeNavigation,\n  eA as be,",
    ],
    [
      "    { activeOrganization: w, refetch: E } = We(),",
      "    { account: codeAccount, activeOrganization: w, refetch: E } = We(),",
    ],
    [
      "    if (le || ue) {",
      "    if (le || ue || (c === \"/code/sessions\" &&\n      __claudexWebCodeNavigation({ account: codeAccount, activeOrganization: w }))) {",
    ],
  ],
  "assets/v1/cfdc866bf-BDSl0H9m.js": [
    [
      `function Pi(e) {
  let $ = J9(71),
    { images: r, files: o, videos: s, chipsLead: c } = e,`,
      `function useClaudexHistoryImages(images) {
  const org = window.__claudexOfficialAccountContext?.orgUuid;
  const prefix = org && "/api/" + org + "/files/";
  const [resolved, setResolved] = t();
  const isPreview = (src) => prefix && typeof src === "string" &&
    src.startsWith(prefix) && /^[a-f0-9-]{36}\\/preview$/.test(src.slice(prefix.length));
  m(() => {
    const paths = new Set(images.filter(({ src }) => isPreview(src)).map(({ src }) => src));
    if (!paths.size) return;
    const controller = new AbortController();
    const urls = new Map();
    void Promise.all([...paths].map(async (src) => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("image/"))
          throw Error("Image unavailable");
        const blob = await response.blob();
        if (!controller.signal.aborted) urls.set(src, URL.createObjectURL(blob));
      } catch {
        if (!controller.signal.aborted) urls.set(src, null);
      }
    })).then(() => {
      if (!controller.signal.aborted) setResolved({ images, urls });
    });
    return () => {
      controller.abort();
      for (const url of urls.values()) if (url) URL.revokeObjectURL(url);
    };
  }, [images, org]);
  if (!images.some(({ src }) => isPreview(src))) return images;
  return images.map((image) => {
    if (!isPreview(image.src)) return image;
    const url = resolved?.images === images ? resolved.urls.get(image.src) : void 0;
    return url === null ? image : { ...image, src: url ?? Na, fullSrc: url ?? Na };
  });
}
function Pi(e) {
  let $ = J9(71),
    { images: rawImages, files: o, videos: s, chipsLead: c } = e,
    r = useClaudexHistoryImages(rawImages),`,
    ],
  ],
  "assets/v1/c63275c0a-B8KNacgV.js": [
    [
      `  Oo as c,\n  Qa as l,`,
      `  Oo as c,\n  Oo as __claudexUseSyncExternalStore,\n  Qa as l,`,
    ],
    [
      `  let Cr = n.awaitingTurn === "head",`,
      `  const hostedQueue = window.__claudexOfficialAccountContext;
  const inputProcessed = __claudexUseSyncExternalStore(
    hostedQueue?.subscribeCodeInputReceipts ?? (() => () => {}),
    () => !!T && hostedQueue?.isCodeInputProcessed?.(T, n.sourceUuid ?? n.id) === true,
  );
  let Cr = n.awaitingTurn === "head" && !inputProcessed,`,
    ],
  ],
  "assets/v1/c06cf64bb-CcaN03HG.js": [
    [
      `function Y(e, t) {\n  q.has(e) && C_(e, t);\n}`,
      `function Y(e, t) {\n  q.has(e) && C_(e, t);\n}
const claudexQueueLocked = (row) =>
  row.claudexQueueState === "sending" || row.claudexQueueState === "unknown";
export function __claudexLockedCodeQueueIds(id) {
  return (J(id)?.queuedDeferred ?? []).filter(claudexQueueLocked).map(V);
}
export function __claudexHasActionableCodeQueueEntry(id, uuid) {
  return (J(id)?.queuedDeferred ?? []).some((row) =>
    (row.claudexQueueState === "queued" || row.claudexQueueState === "held") &&
    (uuid === void 0 || V(row) === uuid));
}
window.__claudexOfficialAccountContext?.subscribeCodeQueue?.((id, rows) => {
  C_(id, (state) => {
    const previous = [...state.queuedDeferred, ...state.queuedSteered]
      .filter((row) => row.claudexQueueState !== void 0).map(V);
    if (!previous.length && !rows.length) return state;
    const projected = new Set(rows.map(V));
    const keep = (row) => row.claudexQueueState === void 0 && !projected.has(V(row));
    const held = [
      ...(state.heldAfterError ?? []).filter((uuid) => !previous.includes(uuid)),
      ...rows.filter((row) => row.claudexQueueState === "held" || row.claudexQueueState === "unknown").map(V),
    ];
    return {
      ...state,
      queuedDeferred: [...rows, ...state.queuedDeferred.filter(keep)],
      queuedSteered: state.queuedSteered.filter(keep),
      heldAfterError: held.length ? [...new Set(held)] : null,
    };
  });
});`,
    ],
    [
      `  return e?.unechoedSendRows.flatMap(ob) ?? Mg;`,
      `  return e ? [...e.unechoedSendRows.flatMap(ob),
    ...e.queuedDeferred.filter(claudexQueueLocked).map(V)] : Mg;`,
    ],
    [
      `                  E = p && !y && Rg(n.message),`,
      `                  E = p && Rg(n.message) && (!y ||
                    (window.__claudexOfficialAccountContext &&
                      /^(?:session|cse)_[a-f0-9]{32}$/.test(e))),`,
    ],
  ],
  "assets/v1/cc43287c9-BDrqHHqn.js": [
    [
      '          t.kind === "cloud" &&\n            n.some((e) => e.environment_id === t.environmentId && e.kind === "anthropic_cloud")',
      '          t.kind === "cloud" && !window.__claudexOfficialAccountContext &&\n            n.some((e) => e.environment_id === t.environmentId && e.kind === "anthropic_cloud")',
    ],
    [
      `  sn as Xee,\n  t as mA,`,
      `  sn as Xee,\n  __claudexHasActionableCodeQueueEntry,\n  __claudexLockedCodeQueueIds,\n  t as mA,`,
    ],
    [
      `    Dh = q !== null && !Sh && Ch && Eh && !_n && !ci,`,
      `    hostedQueue = q?.type === "remote" && __claudexHasActionableCodeQueueEntry(q.id),
    Dh = hostedQueue || (q !== null && !Sh && Ch && Eh && !_n && !ci),`,
    ],
    [
      `    Ah = Th ? Yc : Dh ? kh : void 0,`,
      `    Ah = Dh ? kh : Th ? Yc : void 0,`,
    ],
    [
      `...Object.keys(queueDelivery).filter((id) => queueDelivery[id] === "accepted")]) : Nh,`,
      `...Object.keys(queueDelivery).filter((id) => queueDelivery[id] === "accepted")])
    : q?.type === "remote" && window.__claudexOfficialAccountContext
      ? new Set([...(Nh ?? []), ...__claudexLockedCodeQueueIds(q.id)]) : Nh,`,
    ],
    [
      `          if (lM(q.id)) {
            let t = Jee(q.id);`,
      `          if (window.__claudexOfficialAccountContext && q.type === "remote" &&
              /^(?:session|cse)_[a-f0-9]{32}$/.test(q.id)) {
            Kj(q.id);
            return (od({ ...q, claudexQueuedNowUuid: e }), !0);
          }
          if (lM(q.id)) {
            let t = Jee(q.id);`,
    ],
  ],
  "assets/v1/c6b8adeaf-9EdC4eB_.js": [
    [
      `            m = d && f !== void 0 && p !== void 0,`,
      `            runner = n.type === "remote" && /^(?:session|cse)_[a-f0-9]{32}$/.test(n.id)
              ? window.__claudexOfficialAccountContext : void 0,
            turnTarget = runner?.codeStopTarget(n.id, u?.sendUuid ?? u?.promptUuid),
            m = !runner && d && f !== void 0 && p !== void 0,`,
    ],
    [
      `            await r.stop(n.id, { cancelQueued: m, ...(h && { onReceipt: v }) });`,
      `            const cancelledStart = await r.stop(n.id, {
              cancelQueued: m,
              ...(h && { onReceipt: v }),
              ...(n.claudexQueuedNowUuid && { queuedMessageUuid: n.claudexQueuedNowUuid }),
              ...(runner && {
                runner: true,
                turnTarget,
                startingInputUuid: !turnTarget && !n.claudexQueuedNowUuid ? u?.sendUuid : void 0,
              }),
            });
            if (runner) {
              if (cancelledStart && cancelledStart === u?.sendUuid && f !== void 0)
                i(n.id, f, cancelledStart, { cancelled: [cancelledStart] });
              else if (f !== void 0) H.getState().clearInterrupting(n.id, f);
              else if (n.claudexQueuedNowUuid)
                H.getState().beginPendingTurn(n.id, { sendUuid: n.claudexQueuedNowUuid });
            }`,
    ],
  ],
  "assets/v1/ca80fca8d-LvEosFmV.js": [
    [
      "  Ex as ee,\n  FB as C,",
      "  Ex as ee,\n  __claudexWebCodeNavigation,\n  FB as C,",
    ],
    [
      "Yl as le, ce, oS as N, pV as se, ry as ue",
      "Yl as le, ce, ce as __claudexUseAccount, oS as N, pV as se, ry as ue",
    ],
    [
      "function Sr(e, t) {\n  let $ = J9(13),",
      "function __claudexWebWorkspaceDiff(auth) {\n  return __claudexWebCodeNavigation(auth) && auth.account?.claudex_web_code?.workspace_diff_available === true;\n}\nfunction Sr(e, t) {\n  const __claudexWorkspaceDiff = __claudexWebWorkspaceDiff(__claudexUseAccount());\n  let $ = J9(13),",
    ],
    [
      "let t = J3($, 0, s, n, e) ? K3($, 0, s, n, e, n ? Be(e, s) : void 0) : $[3],",
      "let __claudexMinimum = J3($, 0, s, n, e) ? K3($, 0, s, n, e, n ? Be(e, s) : void 0) : $[3],\n      t = __claudexWorkspaceDiff ? void 0 : __claudexMinimum,",
    ],
    [
      '} from "./c5da7eb42-BOzerWAp.js";',
      '} from "./c5da7eb42-BOzerWAp.js";\nimport { __claudexHostedCodeWorkspace, __claudexHostedWorkspaceChanges } from "./c5da7eb42-BOzerWAp.js";',
    ],
    [
      `    a = e?.type,
    o = Sr(a, r),
    s = o && i ? i : null,
    c = on(s),
    u = c === "connected",`,
      `    a = e?.type,
    original = Sr(a, r),
    workspace = a === "remote" && !!__claudexHostedCodeWorkspace(i),
    s = (workspace || original) && i ? i : null,
    c = on(s),
    u = c === "connected",
    hosted = workspace && (!original || !u),
    o = hosted ? __claudexHostedWorkspaceChanges : original,`,
    ],
    [
      '    h = s !== null && u && m,',
      '    h = s !== null && (hosted || (u && m)),',
    ],
    [
      '    y = d && !f && W(p) ? vr : !1,',
      '    y = hosted ? 5e3 : d && !f && W(p) ? vr : !1,',
    ],
    [
      `    { data: i } = Re(e ?? "", r),
    { mutate: a } = Fe(),`,
      `    { data: i } = Re(e ?? "", r),
    connectorMutation = Fe(),
    runner = typeof window < "u" && !!window.__claudexOfficialAccountContext &&
      /^(?:session|cse)_[a-f0-9]{32}$/.test(e),
    a = runner ? connectorMutation.mutateAsync : connectorMutation.mutate,`,
    ],
    [
      `                if (!e || !n || l === void 0 || !t.url || (r && lt(t))) return;
                let i = { ...l };`,
      `                if (!e || !n || l === void 0 || !t.url || (r && lt(t))) return;
                if (runner) {
                  const key = [b, { orgUuid: o?.uuid, sessionId: e }],
                    previous = s.getQueryData(key);
                  if (!previous || Ke(previous)) return;
                  const mcpServers = { ...previous.session_context.mcp_config?.mcpServers };
                  if (r) mcpServers[t.uuid] = {
                    type: "http", url: t.url, headers: { "X-MCP-Server-ID": t.uuid },
                  };
                  else delete mcpServers[t.uuid];
                  const mcpConfig = { mcpServers },
                    optimistic = s.setQueryData(key, {
                      ...previous, session_context: { ...previous.session_context, mcp_config: mcpConfig },
                    });
                  void a({ sessionId: e, mcpConfig }).catch(() => {
                    s.setQueryData(key, (current) => current === optimistic ? previous : current);
                  }).finally(() => s.invalidateQueries({ queryKey: key, exact: true })).catch(() => {});
                  return;
                }
                let i = { ...l };`,
    ],
  ],
  "assets/v1/c03935b01-C5mJBQhH.js": [
    [
      `  (Wt?.stopShellPty(t), Yt.get(e)?.stopShellPty(t));`,
      `  (Wt?.stopShellPty(t), Yt.get(e)?.stopShellPty(t));
  if (typeof window < "u") window.__claudexOfficialAccountContext?.codeTerminal?.stop(e, t);`,
    ],
  ],
  "assets/v1/c5da7eb42-BOzerWAp.js": [
    [
      `function Jv(e) {
  let t = e.requestedSchema;`,
      `function Jv(e, hostedWorkflow) {
  let t = e.requestedSchema;`,
    ],
    [
      `    Sc(Zt(e.serverName)) ||
    !sn(t) ||`,
      `    (!hostedWorkflow && Sc(Zt(e.serverName))) ||
    !sn(t) ||`,
    ],
    [
      `  let o = r?.drawsForms?.() === !0 ? Jv(t) : void 0;`,
      `  let o = r?.drawsForms?.() === !0
    ? Jv(t, __claudexHostedCodeCursor(e) && t.serverName === "claudex_workflow")
    : void 0;`,
    ],
    [
      `var J_ = new Map();
function Y_(e, t, n = 1 / 0) {
  t > n || (t > (J_.get(e) ?? 0) && J_.set(e, t));
}`,
      `var J_ = new Map();
function __claudexHostedCodeCursor(e) {
  return typeof window < "u" && !!window.__claudexOfficialAccountContext &&
    /^(?:session|cse)_[a-f0-9]{32}$/.test(e);
}
function __claudexCodeResumeHeaders(e, cursor) {
  if (!__claudexHostedCodeCursor(e) || !cursor) return {};
  if (cursor.sequence === 0) return { "Last-Event-ID": "0" };
  if (cursor.eventId) return { "Last-Event-ID": cursor.sequence + ":" + cursor.eventId };
  return {};
}
function Y_(e, t, n = 1 / 0, eventId) {
  if (t > n || t <= (J_.get(e)?.sequence ?? 0)) return;
  if (__claudexHostedCodeCursor(e) &&
      (typeof eventId !== "string" || !/^evt_[a-f0-9]{64}$/.test(eventId))) return;
  J_.set(e, { sequence: t, eventId });
}`,
    ],
    [
      `  a > 0 && Y_(e, a);`,
      `  if (a > 0 && __claudexHostedCodeCursor(e)) {
    for (const row of t) {
      const sequence = Ao(row);
      if (sequence !== void 0) Y_(e, sequence, a, row.ccr_event?.event_id);
    }
  } else if (a > 0) Y_(e, a);`,
    ],
    [
      `        onCatchUpTruncated() {
          n.aborted || t({ kind: "tail_stale" }, "sse_catch_up_truncated_emit");
        },`,
      `        onCatchUpTruncated(claudexReset) {
          if (n.aborted) return;
          if (claudexReset === true && __claudexHostedCodeCursor(e)) {
            J_.set(e, { sequence: 0 });
            Z_.delete(e);
            av.delete(e);
            r.clear();
            i.clear();
            a.clear();
            o.length = 0;
            clearTimeout(c);
            s = false;
            t({ kind: "cleared" }, "sse_host_transcript_reset");
            return;
          }
          t({ kind: "tail_stale" }, "sse_catch_up_truncated_emit");
        },`,
    ],
    [
      `          Y_(e, o.sequence_num, a),`,
      `          Y_(e, o.sequence_num, a, o.event_id),`,
    ],
    [
      `    return (cv(e, Ts(n).data, await y(e)), J_.get(e) ?? 0);`,
      `    return (cv(e, Ts(n).data, await y(e)), J_.get(e) ?? { sequence: 0 });`,
    ],
    [
      `              let he = b ? (J_.get(e) ?? (await se(e))) : void 0;`,
      `              const resume = b ? (J_.get(e) ?? (await se(e))) : void 0;
              let he = resume?.sequence;`,
    ],
    [
      `                Pe = { ...Ss(e, he), headers: Object.assign(K_(), x), ...Ne },`,
      `                Pe = { ...Ss(e, he), headers: Object.assign(K_(), x, __claudexCodeResumeHeaders(e, resume)), ...Ne },`,
    ],
    [
      `    async getContextUsage(e, t) {
      let n = await Ge(e);`,
      `    async getContextUsage(e, t) {
      if (window.__claudexOfficialAccountContext && /^(?:session|cse)_[a-f0-9]{32}$/.test(e)) {
        const response = await b("/v1/code/sessions/" + Xa(e), { headers: x });
        if (!response.ok) return null;
        return (await response.json()).session?.claudex_context_usage ?? null;
      }
      let n = await Ge(e);`,
    ],
    [
      `    let i = await r.json(),
      a = Ts(i);
    n?.settle !== !1`,
      `    let i = await r.json(),
      a = Ts(i);
    if (t === void 0 && window.__claudexOfficialAccountContext && Array.isArray(i.claudex_commands))
      Tk(e, { slash_commands: i.claudex_commands }, "live");
    n?.settle !== !1`,
    ],
    [
      `      { rows: a.data.slice().reverse(), next: s, hasWorkerReset: o }`,
      `      { rows: [
          ...a.data.slice().reverse(),
          ...(t === void 0 && window.__claudexOfficialAccountContext && Array.isArray(i.claudex_task_updates)
            ? i.claudex_task_updates : []),
        ], next: s, hasWorkerReset: o }`,
    ],
    [
      `  iO as ct,\n  j0 as We,`,
      `  iO as ct,\n  j0 as We,\n  __claudexWebCodeNavigation,`,
    ],
    [
      `  return { kindKnown: !!e, remoteKind: e?.remote?.kind, isOwnedRemote: !!e && !e.isShared };`,
      `  return { kindKnown: !!e, remoteKind: e?.remote?.kind, isOwnedRemote: !!e && !e.isShared, isArchived: e?.isArchived === true };`,
    ],
    [
      `      isOwnedRemote: c,
    } = nR(J1($, 0, e) ? K1($, 0, e, Lu(e)) : $[1], t),`,
      `      isOwnedRemote: c,
      isArchived: archived,
    } = nR(J1($, 0, e) ? K1($, 0, e, Lu(e)) : $[1], t),`,
    ],
    [
      `    l = B("ccr_cardboard_truck"),`,
      `    l = B("ccr_cardboard_truck"),
    auth = Lr(),
    hosted = __claudexWebCodeNavigation(auth),`,
    ],
    [
      `    if (u !== "remote" || !d || !l || p) {`,
      `    if (u !== "remote" || !d || (!l && !hosted) || p) {`,
    ],
    [
      `    m = J1($, 2, d) ? K1($, 2, d, Ju(d)) : $[3];`,
      `    m = hosted
      ? !archived && auth.account.claudex_web_code.terminal_available === true
        ? window.__claudexOfficialAccountContext.codeTerminal?.forSession(d)
        : void 0
      : J1($, 2, d) ? K1($, 2, d, Ju(d)) : $[3];`,
    ],
    [
      `  zn as Lf,\n} from "./c06cf64bb-CcaN03HG.js";`,
      `  zn as Lf,\n  __claudexHasActionableCodeQueueEntry,\n} from "./c06cf64bb-CcaN03HG.js";`,
    ],
    [
      `    async cancelQueued(e, t) {
      if (!tO(e)) return !1;
      let n = await Ge(e);
      if (!n) return !1;
      let r;
      try {`,
      `    async cancelQueued(e, t) {
      const hostedQueue = __claudexHasActionableCodeQueueEntry(e, t);
      if (!hostedQueue && !tO(e)) return !1;
      let r;
      try {
        if (hostedQueue) {
          const answer = await Pe(e, [{
            type: "control_request",
            request_id: "cancel_async_message-" + crypto.randomUUID(),
            request: { subtype: "cancel_async_message", message_uuid: t },
          }]);
          const cancelled = answer.ok && (await answer.json()).cancelled === !0;
          if (cancelled) bt(e);
          return cancelled;
        }
        let n = await Ge(e);
        if (!n) return !1;`,
    ],
    [
      `      let a = !i && !r && mo() ? f?.(e) : void 0,`,
      `      let hosted = t?.runner === !0,
        a = !hosted && !i && !r && mo() ? f?.(e) : void 0,`,
    ],
    [
      `          request: { subtype: "interrupt", ...(i && { cancel_queued: !0 }) },`,
      `          request: {
            subtype: "interrupt",
            ...(i && { cancel_queued: !0 }),
            ...(t?.queuedMessageUuid && { queued_message_uuid: t.queuedMessageUuid }),
            ...(t?.turnTarget && { turn_target: t.turnTarget }),
            ...(t?.startingInputUuid && { starting_input_uuid: t.startingInputUuid }),
          },`,
    ],
    [
      `        let r = await Pe(e, [c], t > 1 ? { replayable: !1 } : void 0).finally(() => {`,
      `        let r = await Pe(e, [c], hosted || t > 1 ? { replayable: !1 } : void 0).finally(() => {`,
    ],
    [
      `          i && bt(e);
        });
        if (r.ok) return;`,
      `          i && bt(e);
        });
        if (r.ok) {
          if (hosted && c.request.starting_input_uuid)
            return (await r.json()).cancelled_start;
          return;
        }`,
    ],
    [
      'function pE(e) {\n  return !Iw.has(e)',
      `function __claudexHostedCodeWorkspace(session) {
  const bridge = typeof window < "u" && window.__claudexCodeWorkspace;
  return bridge?.matches(session) ? bridge : null;
}
async function __claudexHostedWorkspaceChanges(session) {
  try {
    const result = await __claudexHostedCodeWorkspace(session)?.changes(session);
    return result?.status === "ok" ? BO({ diff: result.diff }, session)
      : result?.status === "no_repo" ? result : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
export { __claudexHostedCodeWorkspace, __claudexHostedWorkspaceChanges };
function pE(e) {
  return !Iw.has(e)`,
    ],
    [
      `function nD(e) {
  return Rv() && tD(e);
}
function rD(e) {
  return Zv() && tD(e);
}`,
      `function __claudexRunnerElicitation(e) {
  return typeof window < "u" && !!window.__claudexOfficialAccountContext &&
    /^(?:session|cse)_[a-f0-9]{32}$/.test(e) && KE.has(e) &&
    $E(e) && !WE.has(e) && !Iw.has(e);
}
function nD(e) {
  return Rv() && tD(e) || __claudexRunnerElicitation(e);
}
function rD(e) {
  return Zv() && tD(e) || __claudexRunnerElicitation(e);
}`,
    ],
    [
      `  async function at(e, t, n) {
    if (!pE(e) || dD(e) || UT.has(e)) return { status: "unsupported" };`,
      `  async function at(e, t, n) {
    const hosted = __claudexHostedCodeWorkspace(e);
    if (hosted) {
      if (!sC(t)) return { status: "denied", code: "invalid_path" };
      try {
        const entries = await hosted.list(e, t, { signal: n?.signal });
        return Array.isArray(entries) ? { status: "ok", root: "/workspace", entries }
          : { status: "denied", code: entries?.status ?? "invalid_path" };
      } catch {
        return { status: "unavailable" };
      }
    }
    if (!pE(e) || dD(e) || UT.has(e)) return { status: "unsupported" };`,
    ],
    [
      `  async function st(e, t, n) {
    let r = (e, t) => (t ? n?.onNullReason?.(e, t) : n?.onNullReason?.(e), null);`,
      `  async function st(e, t, n) {
    let r = (e, t) => (t ? n?.onNullReason?.(e, t) : n?.onNullReason?.(e), null);
    const hosted = __claudexHostedCodeWorkspace(e);
    if (hosted && !n?.taskOutput) {
      try {
        if (n?.encoding === "base64") {
          const result = await hosted.download(e, t);
          const size = Math.floor(result.content.length * 3 / 4) -
            (result.content.endsWith("==") ? 2 : result.content.endsWith("=") ? 1 : 0);
          return n.maxBytes !== void 0 && size > n.maxBytes ? r("truncated") : {
            contents: result.content, encoding: "base64", fileSize: size,
          };
        }
        const result = await hosted.read(e, t);
        if (result.status === "ok") return result.file;
        const reason = { notFound: "cli_not_found", tooLarge: "truncated", outsideSessionFolders: "client_outside_roots" };
        return r(reason[result.status] ?? "cli_error");
      } catch {
        return r("cli_error");
      }
    }`,
    ],
    [
      `    async getFileSuggestions(e, t) {
      if (dD(e)) return [];`,
      `    async getFileSuggestions(e, t) {
      const hosted = __claudexHostedCodeWorkspace(e);
      if (hosted) return hosted.suggestions(e, t).catch(() => []);
      if (dD(e)) return [];`,
    ],
    [
      `    getWorkspaceRoot(e) {
      let t = $e(e);`,
      `    getWorkspaceRoot(e) {
      if (__claudexHostedCodeWorkspace(e)) return Promise.resolve("/workspace");
      let t = $e(e);`,
    ],
    [
      `  let u = () => {
    (c.resolve({ decision: "deny" }), Y.getState().detachPromiseResolvers(e, t, c), Oy(e));
  };`,
      `  let u = () => {
    if (__claudexRunnerElicitation(e)) {
      c.resolve({ decision: "deny", respondedOutOfBand: true });
      Y.getState().removeRequest(e, t);
      Oy(e);
      return;
    }
    (c.resolve({ decision: "deny" }), Y.getState().detachPromiseResolvers(e, t, c), Oy(e));
  };`,
    ],
    [
      `          (t.resolve({ decision: "deny", aborted: !0 }),
            Y.getState().detachPromiseResolvers(e, s.toolUseID, t));`,
      `          t.resolve({ decision: "deny", aborted: !0 });
          if (__claudexRunnerElicitation(e)) Y.getState().removeRequest(e, s.toolUseID);
          else Y.getState().detachPromiseResolvers(e, s.toolUseID, t);`,
    ],
  ],
  "assets/v1/cfac349aa-ZhAJxSLC.js": [
    [
      '} from "./c5da7eb42-BOzerWAp.js";',
      '} from "./c5da7eb42-BOzerWAp.js";\nimport { __claudexHostedCodeWorkspace } from "./c5da7eb42-BOzerWAp.js";',
    ],
    [
      '  return n.length > 0 || (i && r) || a || o || s || c || l !== null;',
      '  return (e?.type === "remote" && !!__claudexHostedCodeWorkspace(e.id)) || n.length > 0 || (i && r) || a || o || s || c || l !== null;',
    ],
    [
      '  return t && (!n || r) && !i && !a && !o;',
      '  return (e?.type === "remote" && !!__claudexHostedCodeWorkspace(e.id)) || (t && (!n || r) && !i && !a && !o);',
    ],
    [
      '  return V && ((n && t) || i || (a !== null && !o));',
      '  return (e?.type === "remote" && !!__claudexHostedCodeWorkspace(e.id)) || (V && ((n && t) || i || (a !== null && !o)));',
    ],
  ],
  "assets/v1/cd2efac6e-DHz2EyWB.js": [
    [
      '} from "./shared-1-B16QIYNI.js";',
      '} from "./shared-1-B16QIYNI.js";\nimport { ue as __claudexWorkspaceBytes } from "./shared-1-B16QIYNI.js";',
    ],
    [
      '} from "./c5da7eb42-BOzerWAp.js";',
      '} from "./c5da7eb42-BOzerWAp.js";\nimport { __claudexHostedCodeWorkspace } from "./c5da7eb42-BOzerWAp.js";',
    ],
    [
      '    ...(r === "cloud" ? Tc : void 0),',
      '    ...(r === "cloud" ? Tc : void 0),\n    ...(r === "cloud" && __claudexHostedCodeWorkspace(n) ? { refetchInterval: 5e3 } : void 0),',
    ],
    [
      `    t = e?.type === "remote" ? e.id : null,
    { data: n, isPending: r } = wi(e),
    i = n?.isRunning === !0 || n?.isConnected === !0,
    a = Ro(t, i),`,
      `    t = e?.type === "remote" ? e.id : null,
    hosted = !!__claudexHostedCodeWorkspace(t),
    { data: n, isPending: r } = wi(e),
    i = n?.isRunning === !0 || n?.isConnected === !0,
    a = Ro(hosted ? null : t, i),`,
    ],
    [
      '    p = t !== null && n !== void 0,\n    m = J1($, 6, t)',
      '    p = t !== null && (hosted || n !== void 0),\n    m = J1($, 6, t)',
    ],
    [
      '    S = y !== null && i,',
      '    S = y !== null && (hosted || i),',
    ],
    [
      '    M = T && C === void 0,',
      '    M = T && C === void 0 && !__claudexHostedCodeWorkspace(e?.id),',
    ],
    [
      '        if (e && Rt(e.type)) {\n          j(i);',
      '        if (e && Rt(e.type)) {\n          if (!__claudexHostedCodeWorkspace(e.id)) j(i);',
    ],
    [
      '  let I = n.kind === "session" ? n.sessionRef : null,\n    mt =',
      '  let I = n.kind === "session" ? n.sessionRef : null,\n    hostedWorkspace = I?.type === "remote" ? __claudexHostedCodeWorkspace(I.id) : null,\n    hostedDocument = hostedWorkspace ? uf(r, !0) : null,\n    mt =',
    ],
    [
      '  let Lc = (z || Tc) && m !== "filePaneOnly" ? uf(r, Za || wr) : null,',
      '  let Lc = hostedDocument ?? ((z || Tc) && m !== "filePaneOnly" ? uf(r, Za || wr) : null),',
    ],
    [
      '    Vc = Bc && Tc,',
      '    Vc = hostedDocument !== null || (Bc && Tc),',
    ],
    [
      `    Zc =
      (U || Bc) &&
      (Qa !== null || Vc || (z && Jt !== void 0)) &&`,
      `    Zc =
      (U || Bc) &&
      (hostedWorkspace || Qa !== null || Vc || (z && Jt !== void 0)) &&`,
    ],
    [
      `        let { signal: t, queryKey: n, meta: i } = e;
        if (R !== null && Jt !== void 0) {`,
      `        let { signal: t, queryKey: n, meta: i } = e;
        if (hostedWorkspace) {
          const mime = hostedDocument ?? nn(r);
          if (!mime) return { unavailable: "unsupported" };
          try {
            const { content } = await hostedWorkspace.download(I.id, r, { signal: t });
            const bytes = __claudexWorkspaceBytes(content);
            return hostedDocument ? bytes.buffer : ed(gn.getQueryData(n), bytes, mime);
          } catch (error) {
            if (t.aborted) throw error;
            return { unavailable: "load_failed" };
          }
        }
        if (R !== null && Jt !== void 0) {`,
    ],
    [
      '    Op = Ei(I) || G !== null,',
      '    Op = Ei(I) || G !== null || !!hostedWorkspace,',
    ],
    [
      '    n_ = !z && ',
      '    n_ = !z && hostedWorkspace\n      ? Y != null || typeof q.data === "string" || q.data instanceof Blob || q.data instanceof ArrayBuffer\n      : !z && ',
    ],
  ],
  "assets/v1/c9bd7af9c-B1XHjRXl.js": [
    [
      `    ue = Pt(),
    de = m(ue),`,
      `    ue = Pt() && window.__claudexOfficialAccountContext?.codePreviewAvailable !== true,
    de = m(ue),`,
    ],
    [
      `    Ct = J1($, 120, xt) ? K1($, 120, xt, xt && !Vt()) : $[121],`,
      `    Ct = J1($, 120, xt)
      ? K1($, 120, xt, xt && !Vt() && window.__claudexOfficialAccountContext?.codePreviewAvailable !== true)
      : $[121],`,
    ],
    [
      '} from "./c5da7eb42-BOzerWAp.js";',
      '} from "./c5da7eb42-BOzerWAp.js";\nimport { __claudexHostedCodeWorkspace } from "./c5da7eb42-BOzerWAp.js";',
    ],
    [
      `    i = r.data;
  return n && gb(r)`,
      `    i = r.data;
  if (e.sessionRef?.type === "remote" && __claudexHostedCodeWorkspace(e.sessionRef.id))
    return A(JE, e);
  return n && gb(r)`,
    ],
    [
      '    d = n?.id ?? "landing",\n    { data: f, isLoading: h, isPending: _ } = Wu(n),',
      '    d = n?.id ?? "landing",\n    hosted = n?.type === "remote" && !!__claudexHostedCodeWorkspace(d),\n    { data: f, isLoading: h, isPending: _ } = Wu(n),',
    ],
    [
      'var JE = j((t) => {\n  let $ = J9(287),',
      'var JE = j((t) => {\n  let $ = J9(298),',
    ],
    [
      '    B = _b && !y && (R === void 0 || (R === "wsl" && N)),',
      '    B = hosted || (_b && !y && (R === void 0 || (R === "wsl" && N))),',
    ],
    [
      '    ge = xp() && Cb,',
      '    ge = hosted || (xp() && Cb),',
    ],
    [
      '    Ue = S || (y && Oe !== ""),',
      '    Ue = !Me && (S || (y && Oe !== "")),',
    ],
    [
      `    Tt = J3($, 111, Fe, H, Ie) ? K3($, 111, Fe, H, Ie, [cm, H, Fe, Ie]) : $[114],
    Et = Me && Fe.length > 0 && H.length > 0 && !Ve && !We,
    Ot = J2($, 115, Fe, Ie)
      ? K2($, 115, Fe, Ie, async () => {
          let e = Ie
            ? await rt?.searchFileContentsWithOptions?.({ query: Fe, options: Ie, maxResults: ME })
            : { matches: await rt?.searchFileContents?.(Fe, ME), patternRefused: !1 };`,
      `    Tt = J5($, 287, Fe, H, Ie, d, hosted)
      ? K5($, 287, Fe, H, Ie, d, hosted, [cm, H, Fe, Ie, ...(hosted ? [d] : [])])
      : $[292],
    Et = Me && Fe.length > 0 && H.length > 0 && !Ve && !We,
    Ot = J4($, 293, Fe, Ie, d, hosted)
      ? K4($, 293, Fe, Ie, d, hosted, async () => {
          const workspace = hosted && __claudexHostedCodeWorkspace(d);
          let e = workspace ? await workspace.search(d, { query: Fe, options: Ie, maxResults: ME })
            : Ie
              ? await rt?.searchFileContentsWithOptions?.({ query: Fe, options: Ie, maxResults: ME })
              : { matches: await rt?.searchFileContents?.(Fe, ME), patternRefused: !1 };`,
    ],
    [
      `            : CD(e?.matches ?? [], ME, AE, jE);
        })
      : $[117],
    kt =`,
      `            : CD(e?.matches ?? [], ME, AE, jE);
        })
      : $[297],
    kt =`,
    ],
    [
      '    zt = y && !oe && (S || Pe !== ""),',
      '    zt = y && !oe && !Me && (S || Pe !== ""),',
    ],
    [
      '          Ft(`${ne}\\u0000${Pe}`);',
      '          if (!__claudexHostedCodeWorkspace(d)) Ft(`${ne}\\u0000${Pe}`);',
    ],
  ],
  "assets/v1/cb61be3a2-CHkCCkPy.js": [
    [
      '} from "./c5da7eb42-BOzerWAp.js";',
      '} from "./c5da7eb42-BOzerWAp.js";\nimport { __claudexHostedCodeWorkspace } from "./c5da7eb42-BOzerWAp.js";',
    ],
    [
      '((B = Ze(e?.type, Ee, b, gt, C.overridden)),',
      '((B = e?.type === "remote" && __claudexHostedCodeWorkspace(e.id) ? "pane" : Ze(e?.type, Ee, b, gt, C.overridden)),',
    ],
  ],
  "assets/v1/c4f16e4f0-Bzds_lWM.js": [
    [
      `function Cr(e) {`,
      `function __claudexCoworkHistory(session, account) {
  const host = window.__claudexOfficialAccountContext;
  const capability = account?.claudex_web_cowork_history;
  return O(session) === "ccr" && !!host && account?.uuid === host.accountUuid &&
    capability?.account_uuid === host.accountUuid && capability?.organization_uuid === host.orgUuid;
}
function __claudexCoworkWritable(session, account) {
  return __claudexCoworkHistory(session, account) && account?.claudex_web_cowork_history?.followup_available === true;
}
function Cr(e) {`,
    ],
    [
      '    d = et(s, c, l.served),',
      '    runnerCowork = __claudexCoworkHistory(t, Y().account),\n    runnerCoworkWritable = __claudexCoworkWritable(t, Y().account),\n    d = runnerCowork ? runnerCoworkWritable : et(s, c, l.served),',
    ],
    [
      '    m = V(p.flagServed),',
      '    m = V(p.flagServed) && !runnerCowork,',
    ],
    [
      '  let T = h && C && !x,\n    E = !T && (te || (h && v && !x)),',
      '  let T = h && C && !x && !runnerCowork,\n    E = runnerCowork ? !runnerCoworkWritable : (!T && (te || (h && v && !x))),',
    ],
    [
      'function Yr(e, n) {\n  let $ = J9(15),',
      'function Yr(e, n) {\n  const runnerCowork = __claudexCoworkHistory(e, Y().account);\n  n = n || runnerCowork;\n  let $ = J9(15),',
    ],
  ],
  "assets/v1/c56477982-BKCIDeJR.js": [
    [
      'import { xB as g } from "./shared-m-4-CbJwwS_m.js";',
      'import { HL as decodeWorkspaceFile, xB as g } from "./shared-m-4-CbJwwS_m.js";',
    ],
    [
      "async function F(e, t) {",
      `export function __claudexCloudWorkspaceSession() {
  return window.__claudexOfficialAccountContext &&
    /^\\/code\\/((?:session|cse)_[a-f0-9]{32})$/.exec(window.location.pathname)?.[1];
}
async function __claudexReadWorkspaceFile(session, file) {
  const account = window.__claudexOfficialAccountContext;
  const response = await fetch(\`/v1/code/sessions/\${session}/file?\${new URLSearchParams({ path: file })}\`, {
    headers: { "x-organization-uuid": account.orgUuid },
  });
  if (response.status === 404) return { cause: "missing" };
  if (response.status === 400 && (await response.json()).error?.reason === "session_file_too_large")
    return { cause: "too_large" };
  if (!response.ok) return { cause: "read_error" };
  const { content } = await response.json();
  return { bytes: decodeWorkspaceFile(content) };
}
async function F(e, t) {`,
    ],
    [
      "    L = localSessionId ?? (P === null ? null : I),",
      "    cloud = __claudexCloudWorkspaceSession(),\n    L = cloud ?? localSessionId ?? (P === null ? null : I),",
    ],
    [
      "    reader = P ?? localSessionId ?? null,",
      "    reader = P ?? cloud ?? localSessionId ?? null,",
    ],
    [
      `            a = await (j(e) ? Y(e) : X(e)).catch((e) => ({`,
      `            a = await (cloud ? __claudexReadWorkspaceFile(cloud, e) : j(e) ? Y(e) : X(e)).catch((e) => ({`,
    ],
  ],
  "assets/v1/cb6930dae-D_Z01Onq.js": [
    [
      'import { n as Os, r as ks, t as As } from "./c56477982-BKCIDeJR.js";',
      'import { __claudexCloudWorkspaceSession, n as Os, r as ks, t as As } from "./c56477982-BKCIDeJR.js";',
    ],
    [
      '    a = i === "ssh" || i === "wsl",\n    o = fa() !== null,',
      '    cloud = !!__claudexCloudWorkspaceSession(),\n    a = cloud || i === "ssh" || i === "wsl",\n    o = fa() !== null || cloud,',
    ],
    [
      `                children: v(n, {
                  onDownload: () => void c(t.path, he(t.path), !1),
                  downloadBusy: s,
                }),`,
      `                children: __claudexCloudWorkspaceSession() && n.props.onOpen === void 0
                  ? v(n, { onOpen: () => void c(t.path, he(t.path), !1), busy: s })
                  : v(n, { onDownload: () => void c(t.path, he(t.path), !1), downloadBusy: s }),`,
    ],
  ],
  "assets/v1/ce5658dc8-DnpnXkcR.js": [
    ["    a = Nt(),\n    o = Pt(),\n    [s, c] = Ke(t, ps),", "    a = Nt(),\n    o = Pt(!0),\n    [s, c] = Ke(t, ps),"],
  ],
  "assets/v1/shared-40-nCKOLypK.js": [
    ["    v = $9(),\n    y = J1($, 0, n)", "    v = $9(!o),\n    y = J1($, 0, n)"],
  ],
  "assets/v1/shared-120-CuvT_xum.js": [
    ["      ge = $9(),\n      _e = AU(),", "      ge = $9(!0),\n      _e = AU(),"],
  ],
  "assets/v1/shared-6-abVJ5RR0.js": [
    [
      `function EQ() {
  let $ = J9(3),
    { track: e } = JE(),
    t = rR(),
    n = sz(),
    r = J2($, 0, t, e)
      ? K2($, 0, t, e, async (n) => {
          let r = [];`,
      `function EQ(generatedFiles) {
  let $ = J9(5),
    { track: e } = JE(),
    t = rR(),
    n = sz(),
    { addError } = Re(),
    batch = generatedFiles ? window.__claudexGeneratedFileBatch : void 0,
    r = J4($, 0, t, e, batch, addError)
      ? K4($, 0, t, e, batch, addError, async (n) => {
          if (batch && n.length > 1 && n.every(file => file.fileUuid && !file.isShared)) {
            try {
              await batch(n);
            } catch (error) {
              if (error?.name !== "AbortError") addError({ defaultMessage: "Failed to download files", id: "ZqhXQG" });
            }
            return;
          }
          let r = [];`,
    ],
    [
      "      : $[2];\n  return n && AP?.writeFileDownload ? r : null;",
      "      : $[4];\n  return batch || (n && AP?.writeFileDownload) ? r : null;",
    ],
  ],
  "assets/v1/cfe1b8ada-3ZQn_bW7.js": [
    [
      "    { project: t, canEditKnowledgeBase: r, instructionsPending: o, hideWhenEmpty: c } = e,",
      "    { project: t, canEditKnowledgeBase, instructionsPending: o, hideWhenEmpty: c } = e,\n    r = t.claudex_can_edit_instructions ?? canEditKnowledgeBase,",
    ],
  ],
  "assets/v1/cdeaafbfc-Bs8B_xOb.js": [
    [
      `  let g = t.prompt_template,
    _ = J3($, 23, r, g, u)
      ? K3(
          $,
          23,
          r,
          g,
          u,
          r
            ? h(j, {`,
      `  let g = t.prompt_template,
    canEditInstructions = t.claudex_can_edit_instructions ?? r,
    _ = J3($, 23, canEditInstructions, g, u)
      ? K3(
          $,
          23,
          canEditInstructions,
          g,
          u,
          canEditInstructions
            ? h(j, {`,
    ],
    [
      `    w = !r,
    T = J4($, 45, l, d, t, w)
      ? K4(
          $,
          45,
          l,
          d,
          t,
          w,
          h(
            Jt,
            {
              currentView: d,
              setCurrentView: f,
              onClose: C,
              project: t,
              viewOnly: w,
              hideRecommendedTools: l,
`,
      `    w = d === "instructions" ? !canEditInstructions : !r,
    hideTools = l || (d === "instructions" && canEditInstructions && !r),
    T = J4($, 45, hideTools, d, t, w)
      ? K4(
          $,
          45,
          hideTools,
          d,
          t,
          w,
          h(
            Jt,
            {
              currentView: d,
              setCurrentView: f,
              onClose: C,
              project: t,
              viewOnly: w,
              hideRecommendedTools: hideTools,
`,
    ],
  ],
  "assets/v1/shared-22-Ciy9U3_0.js": [
    [
      'function wc(e) {\n  return e.source.kind === "scheduled-task" && e.source.data.opensNewestRun',
      `function wc(e) {
  const sessionId = e.source.kind === "chat" && e.source.data.claudex_cowork_session;
  if (window.__claudexOfficialAccountContext && sessionId && /^session_[a-f0-9]{32}$/.test(sessionId))
    return { kind: "cowork", id: sessionId };
  return e.source.kind === "scheduled-task" && e.source.data.opensNewestRun`,
    ],
    [
      'var Dk = ET,',
      `import { __claudexWebCodeNavigation } from "./shared-l-p-m-w-3-B5uNmf7O.js";
var Dk = ET,`,
    ],
    // Yu persists the Code feed decision across authenticated Web documents.
    [
      `function Yu(e) {
  let $ = J9(9),
    { activeOrganization: t } = E_(),
    n = W1(),`,
      `function Yu(e) {
  let $ = J9(9),
    auth = E_(),
    { activeOrganization: t } = auth,
    original = W1(),
    n = original || __claudexWebCodeNavigation(auth),`,
    ],
  ],
  "assets/v1/shared-39-BVbIfnmZ.js": [
    [
      '      for (let e of X) (!c && e.isArchived) || r.push(PF(e, ve, void 0, be, xe, Se, Ce));\n      let i = Object.values(fe);',
      `      for (let e of X) (!c && e.isArchived) || r.push(PF(e, ve, void 0, be, xe, Se, Ce));
      if (typeof window < "u" && window.__claudexOfficialAccountContext) {
        const coworkIds = new Set(r.filter(row => row.source.kind === "cowork").map(row => row.ref.id));
        r = r.filter(row => row.source.kind !== "chat" || !coworkIds.has(row.source.data.claudex_cowork_session));
      }
      let i = Object.values(fe);`,
    ],
  ],
  "assets/v1/shared-m-2-DfdOu-fU.js": [
    [
      'function Xu(e) {\n  if (typeof window > "u") return;',
      `function __claudexClearSentCodeDraft(e) {
  if (typeof window > "u" || !window.__claudexTakeConfirmedCodeDraft?.(e)) return false;
  XV(e);
  Jn(e, true)?.catch(() => {});
  return true;
}
function Xu(e) {
  if (typeof window > "u" || __claudexClearSentCodeDraft(e)) return;`,
    ],
    [
      'async function b4(e) {\n  if (typeof window > "u" || DO.has(e)) return [];',
      'async function b4(e) {\n  if (typeof window > "u" || __claudexClearSentCodeDraft(e) || DO.has(e)) return [];',
    ],
  ],
  "assets/v1/c30db9bec-DHyXESL4.js": [
    [
      `    deliveredSequenceNum = 0;
    expectedControlResponseIds = new Set();`,
      `    deliveredSequenceNum = 0;
    claudexResumeId;
    expectedControlResponseIds = new Set();`,
    ],
    [
      `      this.lastSequenceNum > 0 && (t["Last-Event-ID"] = String(this.lastSequenceNum));`,
      `      if (this.claudexResumeId !== void 0) t["Last-Event-ID"] = this.claudexResumeId;
      else this.lastSequenceNum > 0 && (t["Last-Event-ID"] = String(this.lastSequenceNum));`,
    ],
    [
      String.raw`                this.logDrop(
                  "catch_up_truncated",
                  "[BrowserSSETransport] catch_up_truncated \u2014 events after the resume cursor were not all replayed",
                  "warn",
                );
                try {
                  this.options.onCatchUpTruncated?.();`,
      String.raw`                const claudexReset = typeof window < "u" && !!window.__claudexOfficialAccountContext &&
                  e.id === "0" && e.data === '{"claudex_transcript_reset":true}';
                if (claudexReset) {
                  this.lastSequenceNum = 0;
                  this.deliveredSequenceNum = 0;
                  this.claudexResumeId = "0";
                } else {
                  this.logDrop(
                    "catch_up_truncated",
                    "[BrowserSSETransport] catch_up_truncated \u2014 events after the resume cursor were not all replayed",
                    "warn",
                  );
                }
                try {
                  this.options.onCatchUpTruncated?.(claudexReset);`,
    ],
    [
      `                  if (e.event === "ephemeral_event") {`,
      `                  if (e.event === "client_event" && t === this.lastSequenceNum &&
                      typeof window < "u" && !!window.__claudexOfficialAccountContext &&
                      /^(?:session|cse)_[a-f0-9]{32}$/.test(this.options.sessionId) &&
                      typeof n.event_id === "string" && /^evt_[a-f0-9]{64}$/.test(n.event_id))
                    this.claudexResumeId = t + ":" + n.event_id;
                  if (e.event === "ephemeral_event") {`,
    ],
  ],
  "assets/v1/shared-m-4-CbJwwS_m.js": [
    [
      `                i?.onCatchUpTruncated?.();
                return;`,
      `                i?.onCatchUpTruncated?.(e.data === '{"claudex_transcript_reset":true}');
                return;`,
    ],
    [
      `  return { ...oC(t ?? {}), type: "internal_session" };
}
function BX(e, t) {`,
      `  const session = oC(t ?? {}), { mcp_config: mcpConfig, cwd } = t?.session_context ?? {};
  if (typeof window < "u" && window.__claudexOfficialAccountContext &&
      /^session_[a-f0-9]{32}$/.test(session.id)) {
    if (mcpConfig !== void 0) session.session_context.mcp_config = mcpConfig;
    if (typeof cwd === "string") session.session_context.cwd = cwd;
    if (t?.project) session.project = t.project;
  }
  return { ...session, type: "internal_session" };
}
function BX(e, t) {`,
    ],
  ],
  "assets/v1/shared-2-CuvP2TaI.js": [
    [
      `function ts(e, t, n, r) {
  let i = !1,`,
      `function ts(e, t, n, r) {
  const sessionId = t;
  let i = !1,`,
    ],
    [
      `          let a = _d(t);
          a && n(a);
          let o = Number(t.sequence_num ?? 0);`,
      `          if (__claudexRunnerCowork(sessionId) && t.source === "worker" &&
              t.payload?.type === "claudex_cowork_approvals" && Array.isArray(t.payload.controls)) {
            n({ kind: "claudex_cowork_approvals", requests: t.payload.controls.flatMap(payload => {
              const event = _d({ source: "worker", payload });
              return event?.kind === "permission_request" || event?.kind === "connect_request"
                ? [{ ...event, request: { ...event.request, claudexCoworkApproval: true } }] : [];
            }) });
            return;
          }
          let a = _d(t);
          a && n(a);
          let o = Number(t.sequence_num ?? 0);`,
    ],
    [
      `    ingest(n, r, i) {
      if (!t().logs[n]) return;`,
      `    ingest(n, r, i) {
      if (!t().logs[n]) return;
      const snapshot = __claudexRunnerCowork(n) && r.find(event => event.kind === "claudex_cowork_approvals");
      if (snapshot) return e(state => __claudexApplyCoworkApprovals(state, n, snapshot.requests));`,
    ],
    [
      "function ja() {",
      `export function __claudexRunnerCowork(session) {
  return typeof window < "u" && !!window.__claudexOfficialAccountContext &&
    /^(?:session|cse)_[a-f0-9]{32}$/.test(session);
}
function __claudexApplyCoworkApprovals(state, session, requests) {
  const log = state.logs[session];
  if (!log) return state;
  const retained = log.events.filter(event => event.request?.claudexCoworkApproval !== true);
  const requestIds = new Set(requests.map(event => event.request.requestId));
  const inFlight = new Set(log.inFlightRespondToolUseIds);
  const responding = new Map(log.inFlightRespondRequestIdByToolUseId);
  for (const event of log.events) {
    const request = event.request;
    if (!request?.claudexCoworkApproval || requestIds.has(request.requestId)) continue;
    const key = request.toolUseId ?? request.requestId;
    if (responding.get(key) !== request.requestId) continue;
    responding.delete(key);
    inFlight.delete(key);
  }
  return { logs: Fd(state, session, {
    events: [...retained, ...requests],
    inFlightRespondToolUseIds: inFlight,
    inFlightRespondRequestIdByToolUseId: responding,
  }) };
}
function __claudexCoworkProjectMove(account, organization) {
  const host = typeof window < "u" ? window.__claudexOfficialAccountContext : void 0;
  if (!host) return void 0;
  const capability = account?.claudex_web_cowork_history;
  return account?.uuid === host.accountUuid && organization === host.orgUuid &&
    capability?.account_uuid === host.accountUuid && capability.organization_uuid === host.orgUuid &&
    capability.project_move === true;
}
function ja() {`,
    ],
    [
      '    { activeOrganization: a } = ce(),\n    o = a?.uuid,\n    { listed: s, writable: c } = _7(),',
      '    { account: __claudexAccount, activeOrganization: a } = ce(),\n    o = a?.uuid,\n    { listed: s, writable: c } = _7(),',
    ],
    [
      '    E = l && T,\n    D = nc(),',
      '    E = __claudexCoworkProjectMove(__claudexAccount, o) ?? (l && T),\n    D = nc(),',
    ],
    [
      '    k = J2($, 36, O, E) ? K2($, 36, O, E, (e) => (OL(e) === "ccr" ? E : O)) : $[38],',
      '    k = J2($, 36, O, E) ? K2($, 36, O, E, (e) => OL(e) === "ccr"\n      ? E && (typeof window > "u" || !window.__claudexOfficialAccountContext || __claudexRunnerCowork(e))\n      : O) : $[38],',
    ],
    [
      '              if (!E || !o)\n                throw ZR(\n                  Error("Session set-project unavailable"),',
      '              if (!E || !o || (typeof window < "u" && window.__claudexOfficialAccountContext && !__claudexRunnerCowork(n)))\n                throw ZR(\n                  Error("Session set-project unavailable"),',
    ],
    [
      '    l = Yo("claude_proj", r.chat_project_id),',
      '    l = (__claudexRunnerCowork(e.id) ? e.project?.uuid : void 0) ?? Yo("claude_proj", r.chat_project_id),',
    ],
    [
      '    u = pD().sessions.names_desktop_project;',
      '    u = pD().sessions.names_desktop_project && !__claudexRunnerCowork(e.id);',
    ],
    [
      '    u = Yo("claude_proj", e.chat_project_id),',
      '    u = (__claudexRunnerCowork(e.id) ? e.project?.uuid : void 0) ?? Yo("claude_proj", e.chat_project_id),',
    ],
    [
      '    d = pD().sessions.names_desktop_project,',
      '    d = pD().sessions.names_desktop_project && !__claudexRunnerCowork(e.id),',
    ],
    [
      '      new xT("setRemoteCoworkSessionProject", r.status),',
      '      __claudexRunnerCowork(t) && r.status === 409\n        ? Error("setRemoteCoworkSessionProject: unconfirmed")\n        : new xT("setRemoteCoworkSessionProject", r.status),',
    ],
  ],
  "assets/v1/shared-3-f8anTwq9.js": [
    [
      `    if (l.kind === "permission_request" || (l.kind === "connect_request" && t)) {`,
      `    if (l.kind === "permission_request" || (l.kind === "connect_request" && (t || l.request.claudexCoworkApproval === true))) {`,
    ],
    [
      `    if (t <= s) {
      (d.add(e.requestId), e.toolUseId && f.add(e.toolUseId));`,
      `    if (e.claudexCoworkApproval !== true && t <= s) {
      (d.add(e.requestId), e.toolUseId && f.add(e.toolUseId));`,
    ],
  ],
  "assets/v1/ca44d5dae-Duwp3Ivb.js": [
    [
      `      if (e.connectAsk !== void 0)
        return S(`,
      `      if (e._rawRemoteRequest?.claudexCoworkApproval === true && e.connectAsk && e.respond &&
          typeof claudexElicitationLink === "function") {
        let url;
        try { url = new URL(e.connectAsk.url); } catch {}
        if (url?.protocol === "https:" && !url.username && !url.password) {
          const ask = { href: url.href, host: url.host, message: e.connectAsk.message ?? "" };
          const decide = (decision, _input, details) => Promise.resolve()
            .then(() => e.respond(decision, e.input))
            .then(() => details?.onAnswered?.(!0), () => details?.onAnswered?.(!1));
          return S(claudexElicitationLink, {
            armKey: e.toolUseId, serverName: e.connectAsk.serverName ?? e.toolName, ask, decide,
          }, e.toolUseId);
        }
      }
      if (e.connectAsk !== void 0)
        return S(`,
    ],
  ],
  "assets/v1/cc18d27d7-D3efb-Mh.js": [
    [
      'import { S_ as f, ja as p } from "./shared-2-CuvP2TaI.js";',
      'import { S_ as f, ja as p, __claudexRunnerCowork } from "./shared-2-CuvP2TaI.js";',
    ],
    [
      "  if (!v || !p) return a ?? i;",
      "  if (!p || (!v && !(__claudexRunnerCowork(m) && n?.canSetProject?.(m)))) return a ?? i;",
    ],
  ],
  "assets/v1/shared-23-xVessQLu.js": [
    [
      "function LJ(e) {\n  return e.isInIframe;\n}",
      `function LJ(e) {
  return e.isInIframe && !(typeof window < "u" && window.__claudexOfficialAccountContext);
}`,
    ],
  ],
  "assets/v1/shared-140-D6FnSjbS.js": [
    [
      '  ja as XO,',
      '  ja as XO,\n  __claudexRunnerCowork,',
    ],
    [
      "!e.is_harmony_project && (e.uuid === i || bD(e))",
      "!e.is_harmony_project && (e.uuid === i || e.claudex_can_move_conversation === true || bD(e))",
    ],
    [
      '    Pe = ke && Me && !Ne,',
      '    Pe = ke && Me && !Ne && !__claudexRunnerCowork(m),',
    ],
    [
      '    Ie = Fe && (_e || !!y),',
      '    __claudexWebProject = __claudexRunnerCowork(m) && Fe,\n    Ie = Fe && (_e || !!y),',
    ],
    [
      '      (he ? (ke ? Fe || (xe && Pe) || Ne : xe || Ie) : xe && (!ke || Pe))',
      '      (__claudexRunnerCowork(m) ? __claudexWebProject : he ? (ke ? Fe || (xe && Pe) || Ne : xe || Ie) : xe && (!ke || Pe))',
    ],
    [
      '                            atriumEnabled: he,',
      '                            atriumEnabled: he || __claudexWebProject,',
    ],
    [
      '    N = J1($, 5, c) ? K1($, 5, c, (e) => !e.is_harmony_project && (e.uuid === c || bD(e))) : $[6],',
      '    N = J1($, 5, c) ? K1($, 5, c, (e) => !e.is_harmony_project && (e.uuid === c ||\n      (typeof window < "u" && window.__claudexOfficialAccountContext ? e.claudex_can_move_conversation === true : bD(e)))) : $[6],',
    ],
    [
      '            : i && d\n              ? gl(V9, {',
      '            : i && d && !__claudexRunnerCowork(d)\n              ? gl(V9, {',
    ],
  ],
  "assets/v1/c752b32f8-CkH0gFtn.js": [
    [
      "K1($, 14, n, (e) => !e.is_harmony_project && (e.uuid === n || Ge(e)))",
      "K1($, 14, n, (e) => !e.is_harmony_project && (e.uuid === n || e.claudex_can_move_conversation === true || Ge(e)))",
    ],
    [
      "!e.is_harmony_project && (e.uuid === n || Ge(e)) && !A.some((t) => t.uuid === e.uuid)",
      "!e.is_harmony_project && (e.uuid === n || e.claudex_can_move_conversation === true || Ge(e)) && !A.some((t) => t.uuid === e.uuid)",
    ],
  ],
  "assets/v1/c9d22852b-C4-qsx4Y.js": [
    [
      "!e.is_harmony_project && e.uuid !== c && oe(e)",
      "!e.is_harmony_project && e.uuid !== c && (e.claudex_can_move_conversation === true || oe(e))",
    ],
  ],
  "assets/v1/shared-l-p-m-w-0-C_nAiu5o.js": [
    [
      "function dP(e, t = va(e)) {\n",
      `function dP(e, t = va(e)) {
  const marker = typeof window < "u" ? window.__claudexOfficialAccountContext?.sessionMarker : undefined;
  if (typeof marker === "string" && marker) return { value: marker, source: "lc" };
`,
    ],
    [
      "function Yt(e, t, n) {\n",
      `function __claudexWebChatOrganization(key) {
  return key === P0.LAST_ACTIVE_ORG && typeof window < "u"
    ? window.__claudexOfficialAccountContext?.orgUuid
    : void 0;
}
function Yt(e, t, n) {
  const organization = __claudexWebChatOrganization(t);
  if (organization !== void 0) return organization;
`,
    ],
    [
      "function dz(e, t, n = !0) {\n",
      `function dz(e, t, n = !0) {
  const organization = __claudexWebChatOrganization(t);
  if (organization !== void 0) return organization;
`,
    ],
    [
      "    set: (e, t, n = {}) => {\n",
      "    set: (e, t, n = {}) => {\n      if (__claudexWebChatOrganization(e) !== void 0) return;\n",
    ],
    [
      "    delete: (e, t) => {\n      (ts.delete(e), ya(e, t));",
      "    delete: (e, t) => {\n      if (__claudexWebChatOrganization(e) !== void 0) return;\n      (ts.delete(e), ya(e, t));",
    ],
  ],
  "assets/v1/shared-l-p-m-w-2-BMCa56Vr.js": [
    [
      'function R2() {\n  if (typeof window > "u") return { orgUuid: void 0, accountUuid: void 0 };\n',
      `function R2() {
  if (typeof window > "u") return { orgUuid: void 0, accountUuid: void 0 };
  if (window.__claudexOfficialAccountContext) return window.__claudexOfficialAccountContext;
`,
    ],
    [
      "    if (e.accountUuid)\n      try {\n        window.localStorage.setItem(Ht, e.accountUuid);",
      "    if (e.accountUuid && !window.__claudexOfficialAccountContext)\n      try {\n        window.localStorage.setItem(Ht, e.accountUuid);",
    ],
  ],
  "assets/v1/shared-l-p-m-w-3-B5uNmf7O.js": [
    [
      'var nX = EF({',
      `export function __claudexWebCodeNavigation({ account, activeOrganization }) {
  const host = typeof window < "u" ? window.__claudexOfficialAccountContext : void 0;
  const capability = account?.claudex_web_code;
  return !!(
    host && capability?.version === 1 && capability.available === true &&
    account.uuid === host.accountUuid && capability.account_uuid === host.accountUuid &&
    activeOrganization?.uuid === host.orgUuid && capability.organization_uuid === host.orgUuid
  );
}
var nX = EF({`,
    ],
    [
      `  Ul = () => {
    let e = l9();
    return aO("bad_moon_rising") && e;
  },`,
      `  Ul = () => {
    const original = l9(), flag = aO("bad_moon_rising"), auth = LO();
    return (flag && original) || __claudexWebCodeNavigation(auth);
  },`,
    ],
    [
      `    claude_code_web: EF({
      feature: "claude_code_web",
      useClientSideGate: () => {
        let e = aO("bad_moon_rising");
        return EUM() && e;
      },
    }),`,
      `    claude_code_web: EF({
      feature: "claude_code_web",
      useClientSideGate: () => {
        const flag = aO("bad_moon_rising"), surface = EUM(), auth = LO();
        return (surface && flag) || __claudexWebCodeNavigation(auth);
      },
    }),`,
    ],
    [
      "function nq(e) {\n  return document.cookie",
      `function nq(e) {
  const marker = e === "sessionKeyLC" && typeof window < "u"
    ? window.__claudexOfficialAccountContext?.sessionMarker : void 0;
  if (marker !== undefined) return [e + "=" + marker];
  const organization = e === "lastActiveOrg" && typeof window < "u"
    ? window.__claudexOfficialAccountContext?.orgUuid : void 0;
  if (organization !== void 0) return [e + "=" + organization];
  return document.cookie`,
    ],
  ],
};

/** Applies the authenticated Web document's context to already verified module bytes. */
export function deriveOfficialWebAccountModule(assetPath, bytes) {
  if (!Object.hasOwn(rules, assetPath)) return undefined;
  let source = bytes.toString("utf8");
  for (const [before, after] of rules[assetPath]) {
    const start = source.indexOf(before);
    if (start === -1 || source.indexOf(before, start + before.length) !== -1)
      throw Error("Official Web account context anchor mismatch: " + assetPath);
    source = source.slice(0, start) + after + source.slice(start + before.length);
  }
  return Buffer.from(source);
}
