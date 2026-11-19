/** Avoid appending an already-restored native Code draft to itself. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hostAuthenticatedExpression } from "./official-ui-host-auth.mjs";

export const hostCodeTakebackRevision = "claudex-code-takeback-draft-v8";
export const hostCodeTakebackTarget = "cc43287c9-BDrqHHqn.js";
const environmentBarTarget = "c5fb4b44f-B4bLKABl.js";
const waitingTarget = "c06cf64bb-CcaN03HG.js";
const deliveryTarget = "c5220dfc1-DEIUVr7J.js";
const contextTarget = "c5da7eb42-BOzerWAp.js";
const contextCardTarget = "ce96f5751-COTRMpp4.js";
export const hostCodeTakebackInputHashes = {
  [hostCodeTakebackTarget]:
    "08075e035ae96c65b2d8cabda369e6c36814be9a11baa3e55344848309a05201",
  [environmentBarTarget]: "975072af3b6411b524b2f742d67e722105a6d122603e5632f5cea8ccbab7a84e",
  [waitingTarget]: "75246236078560111611780d80707474cd55099c9dfeb77db2043df870230456",
  [deliveryTarget]: "71c9e352989aad4313ab2a5c8bd3e0359fce9415ccebf2901dfc6f9ba5d5f0dc",
  [contextTarget]: "cbe897aabeea7fd23abc60c8e4daf6f21fe65ae9126daf5b7702d427fc0bd0b6",
  [contextCardTarget]: "78ed49d78c713101904f394c250be5cdc161203505d721344ba0c6f3dbf41735",
};
export const hostCodeTakebackOriginalHashes = {
  [hostCodeTakebackTarget]:
    "8c2d97cb1dc34e2ecb2e1c6918bac434b698dee3833e447527b445b38509c03f",
  [environmentBarTarget]: hostCodeTakebackInputHashes[environmentBarTarget],
  [waitingTarget]: hostCodeTakebackInputHashes[waitingTarget],
  [deliveryTarget]: "e41fca74ed50f1422508eb8f8c3f6e024bf5bafdb1e2621a91733a443c2bbf0b",
  [contextTarget]: "12dfddd0429176931594a2af8ede486b8f434358a0dac54c5eeaa0c9ffd02cdb",
  [contextCardTarget]: hostCodeTakebackInputHashes[contextCardTarget],
};
export const hostCodeTakebackHelper = `function __claudexHasUsage(e, organization) {
  const capability = e?.claudex_usage_summary;
  return ${hostAuthenticatedExpression} && typeof organization?.uuid === "string" &&
    organization.uuid.length > 0 && capability?.version === 1 && capability.read_only === true &&
    capability.account_uuid === e.uuid && capability.organization_uuid === organization.uuid;
}
function __claudexCodeTakebackText(text, draft, sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith("local_") &&
    typeof text === "string" && text === draft ? text : kT(text, draft);
}
`;
export const hostCodeTakebackRules = [
  {
    file: hostCodeTakebackTarget,
    name: "flow-ssh-status-after-the-code-error-card",
    before: `      Hd = J2($, 787, Sc, iu)
        ? K2($, 787, Sc, iu, Sc ? z("div", { ref: iu, className: Ed }) : null)
        : $[789],`,
    after: `      environmentLineClass = Sc ? (Au === "error" && ld ? "relative" : Ed) : null,
      Hd = J2($, 787, environmentLineClass, iu)
        ? K2($, 787, environmentLineClass, iu, environmentLineClass === null ? null : z("div", {
            ref: iu,
            className: environmentLineClass,
            style: environmentLineClass === Ed ? void 0 : { "--claudex-code-environment-line-position": "static" },
          }))
        : $[789],`,
  },
  {
    file: environmentBarTarget,
    name: "honor-code-environment-line-position",
    before: '                  "data-testid": "environment-bar-line",',
    after: `                  "data-testid": "environment-bar-line",
                  style: { position: "var(--claudex-code-environment-line-position, absolute)" },`,
  },
  {
    file: contextCardTarget,
    name: "reconcile-aggregate-context-with-live-tokens",
    before: `  let i = e.categories,
    a = i.filter((e) => !y(e) && !b(e) && !x(e));`,
    after: `  if (e.detail === "summary" && r !== null && e.categories.length === 2 &&
      e.categories[0].kind === "used" && e.categories[1].kind === "free") {
    e = { ...e, totalTokens: r, categories: [
      { ...e.categories[0], tokens: r },
      { ...e.categories[1], tokens: Math.max(0, e.rawMaxTokens - r) },
    ] };
  }
  let i = e.categories,
    a = i.filter((e) => !y(e) && !b(e) && !x(e));`,
  },
  {
    file: hostCodeTakebackTarget,
    name: "allow-explicit-native-history-commands",
    before: `                  T &&
                  !w(_e[1])
                ) {`,
    after: `                  T &&
                  !w(_e[1]) &&
                  !(["compact", "clear"].includes(_e[1].toLowerCase()) && q?.type === "local" && q.id.startsWith("local_"))
                ) {`,
  },
  {
    file: waitingTarget,
    name: "show-transport-retry-without-adding-history",
    before: `              case "message": {
                if (sn(n.message)) {`,
    after: `              case "message": {
                if (n.message.type === "system" && !n.message.parent_tool_use_id) {
                  if (n.message.subtype === "api_retry_cleared")
                    return t.apiRetry === null ? t : { ...t, apiRetry: null };
                  if (n.message.subtype === "api_retry" && n.message.claudex_transient === true) {
                    const retry = rg(n.message);
                    if (t.apiRetry?.attempt === retry.attempt &&
                        t.apiRetry?.maxRetries === retry.maxRetries && t.apiRetry?.error === retry.error)
                      return t;
                    return { ...t, apiRetry: retry };
                  }
                }
                if (sn(n.message)) {`,
  },
  {
    file: waitingTarget,
    name: "advance-context-after-native-clear",
    before: `                    ...ry(t),
                    refusalFallback: n.unwoundRefusalFallback ? null : Gh(t.refusalFallback),`,
    after: `                    ...ry(t),
                    ...(e.startsWith("local_") && { contextResets: t.contextResets + 1 }),
                    refusalFallback: n.unwoundRefusalFallback ? null : Gh(t.refusalFallback),`,
  },
  {
    file: contextTarget,
    name: "expire-context-on-native-reset",
    before: `          let g = d ?? f;
          if (g) return g.stale && g.resets === a ? g : { ...g, stale: !0, resets: a };`,
    after: `          let g = d ?? f;
          if (!n && p.startsWith("local_") && g?.resets !== a) return null;
          if (g) return g.stale && g.resets === a ? g : { ...g, stale: !0, resets: a };`,
  },
  {
    file: hostCodeTakebackTarget,
    name: "read-account-usage-capability-in-code",
    before: "    { account: Oc } = Js(),",
    after: "    { account: Oc } = Js(),\n    claudexCodeUsage = S(false),",
  },
  {
    file: hostCodeTakebackTarget,
    name: "route-code-usage-to-account-usage",
    before: `  let Lv = J4($, 1126, Wn, R, q, y)
      ? K4($, 1126, Wn, R, q, y, (e) => {
          let t = q !== null && lA(Ik.getState().buckets[q.id]);
          if (q && !t && T9) {`,
    after: `  claudexCodeUsage.current = __claudexHasUsage(Oc, ta);
  let Lv = J4($, 1126, Wn, R, q, y)
      ? K4($, 1126, Wn, R, q, y, (e) => {
          let t = q !== null && lA(Ik.getState().buckets[q.id]);
          if (q && !t && T9 && !claudexCodeUsage.current) {`,
  },
  {
    file: hostCodeTakebackTarget,
    name: "select-this-computer-from-wsl",
    before: 've = u && !de && !f && !h && !q,',
    after: 've = u && ue !== "wsl" && !de && !f && !h && !q,',
  },
  {
    file: hostCodeTakebackTarget,
    name: "import-original-wsl-folder-converter",
    before: "  vdm as zg,",
    after: "  vdm as zg,\n  vdm as __claudexWslFolder,",
  },
  {
    file: hostCodeTakebackTarget,
    name: "add-folders-in-selected-wsl-distribution",
    before: `    let e = Ht?.browseFolder;
    if (!tp || !(Fa || !q) || !e) {`,
    after: `    let e = Ht?.browseFolder;
    if (ap && (Fa || !q) && e) {
      let distro = X?.remote?.distro ?? Z.wslEnvItems.find(item => item.checked)?.distro.name;
      if (distro) {
        ny = async () => {
          let title = A.formatMessage({ defaultMessage: "Add folder to session", id: "f/RPdu" });
          let selected = await e(title, void 0, void 0, distro);
          let folder = selected && __claudexWslFolder(selected, distro);
          !folder || !mr() || (qv([folder]), Oo.current?.scheduleFocus());
        };
        break bb5;
      }
    }
    if (!tp || !(Fa || !q) || !e) {`,
  },
  {
    file: hostCodeTakebackTarget,
    name: "queued-identical-restored-draft",
    before:
      "s.setText(d === null ? f : kT(f, d), { restored: { typedText: void 0, bashMode: h } })",
    after:
      "s.setText(d === null ? f : __claudexCodeTakebackText(f, d, q?.id), { restored: { typedText: void 0, bashMode: h } })",
  },
  {
    file: hostCodeTakebackTarget,
    name: "parked-identical-restored-draft",
    before:
      "o.setText(u === null ? d : kT(d, u), { restored: { typedText: void 0 } })",
    after:
      "o.setText(u === null ? d : __claudexCodeTakebackText(d, u, J), { restored: { typedText: void 0 } })",
  },
  {
    file: hostCodeTakebackTarget,
    name: "observe-original-queue-delivery",
    before: '  yi as aw,\n} from "./c5220dfc1-DEIUVr7J.js";',
    after: '  yi as aw,\n  __claudexUseQueuedSendAcceptance,\n} from "./c5220dfc1-DEIUVr7J.js";',
  },
  {
    file: hostCodeTakebackTarget,
    name: "lock-dispatched-local-steers",
    before: "  let Ph = Nh,\n    Ih =",
    after:
      `  const queueDelivery = __claudexUseQueuedSendAcceptance();
  let Ph = q?.type === "local"
    ? new Set([...(Nh ?? []), ...(Wr ?? []).map((entry) => entry.id),
        ...Object.keys(queueDelivery).filter((id) => queueDelivery[id] === "accepted")]) : Nh,
    Ih =`,
  },
  {
    file: deliveryTarget,
    name: "expose-existing-queue-acceptance",
    before: "export {\n  Yg as $,",
    after: `export function __claudexUseQueuedSendAcceptance() {
  return J((state) => state.pending);
}
export {
  Yg as $,`,
  },
  {
    file: deliveryTarget,
    name: "remote-control-picker-running-capacity",
    before: "    activeCount: a.length,",
    after: "    activeCount: e.bridge_info?.active_sessions ?? a.length,",
  },
  {
    file: deliveryTarget,
    name: "remote-control-selected-running-capacity",
    before: "t ? { sessionId: l, activeCount: s, ...Wi(t) } : void 0",
    after: "t ? { sessionId: l, activeCount: t.bridge_info?.active_sessions ?? s, ...Wi(t) } : void 0",
  },
  {
    file: contextTarget,
    name: "stream-signed-remote-control-sessions",
    before: "function sD(e) {\n  return !Zr().transport.websocket || ($E(e) && !JE(e));\n}",
    after: `function sD(e) {
  if (__claudexRemoteCodeAccount && Z.has(e)) return true;
  return !Zr().transport.websocket || ($E(e) && !JE(e));
}`,
  },
  {
    file: contextTarget,
    name: "scope-remote-control-transport-to-host-account",
    before: "function sB() {\n  let $ = J9(36),\n    { account: e, activeOrganization: t } = Lr(),",
    after: `let __claudexRemoteCodeAccount = false;
function sB() {
  const { account: e, activeOrganization: t } = Lr();
  __claudexRemoteCodeAccount = (${hostAuthenticatedExpression}) && e.claudex_remote_code === true;
  let $ = J9(36),`,
  },
  {
    file: waitingTarget,
    name: "lock-dispatched-local-waiting-rows",
    before: `function Fy(e, t, n) {
  return e.length === 0
    ? []
    : rd([...e]).map((e) => ({
        ...e,
        awaitingPickup: !0,
        ...(t.includes(e.id) ? { waitingLocked: !0 } : {}),`,
    after: `function Fy(e, t, n, sessionId) {
  const localSteer = n === "steer" && sessionId?.startsWith("local_");
  return e.length === 0
    ? []
    : rd([...e]).map((e) => ({
        ...e,
        awaitingPickup: !0,
        ...(localSteer || t.includes(e.id) ? { waitingLocked: !0 } : {}),`,
  },
  ...["n, t", "t, n"].map((args) => ({
    file: waitingTarget,
    name: "scope-waiting-rows-" + args.replace(", ", "-"),
    before: `K3($, 0, r, ${args}, [...Fy(t, r, "steer"), ...Fy(n, r, "queued")])`,
    after: `K3($, 0, r, ${args}, [...Fy(t, r, "steer", e), ...Fy(n, r, "queued")])`,
  })),
];
const sha = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiHostCodeTakebackModule(file, source) {
  if (!Object.hasOwn(hostCodeTakebackInputHashes, file)) return source;
  if (sha(source) !== hostCodeTakebackInputHashes[file])
    throw Error("Pinned Code takeback input mismatch: " + file);
  let output = source;
  for (const rule of hostCodeTakebackRules.filter((rule) => rule.file === file)) {
    if (output.split(rule.before).length !== 2)
      throw Error("Pinned Code takeback anchor mismatch: " + rule.name);
    output = output.replace(rule.before, rule.after);
  }
  return file === hostCodeTakebackTarget ? hostCodeTakebackHelper + output : output;
}

export function applyOfficialUiHostCodeTakeback(directory) {
  directory = fs.realpathSync(directory);
  if (
    directory
      .split(path.sep)
      .some(
        (part) => part === ".restore" || part === "claude-frontend-4.4212.0",
      )
  )
    throw Error("Recovered sources are immutable");
  const modules = Object.keys(hostCodeTakebackInputHashes).map((file) => {
    const location = path.join(directory, file);
    if (!fs.lstatSync(location).isFile())
      throw Error("Code takeback requires a regular assembled file");
    const output = deriveOfficialUiHostCodeTakebackModule(file, fs.readFileSync(location, "utf8"));
    return { file, location, output };
  });
  for (const { location, output } of modules) fs.writeFileSync(location, output);
  return {
    revision: hostCodeTakebackRevision,
    modules: modules.map(({ file, output }) => ({
        file,
        originalSha256: hostCodeTakebackOriginalHashes[file],
        inputSha256: hostCodeTakebackInputHashes[file],
        outputSha256: sha(output),
        rules: hostCodeTakebackRules.filter((rule) => rule.file === file).map((rule) => rule.name),
    })),
  };
}
