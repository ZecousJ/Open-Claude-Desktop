/** Await disposal of the exact official temporary conversation before its existing exit transition. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const hostIncognitoLifecycleRevision =
  "claudex-incognito-explicit-exit-v2";
export const hostIncognitoLifecycleOriginalHashes = {
  "shared-m-2-DfdOu-fU.js":
    "4bff05fcf5c76e3ee12e6196f9fce0ed4409e7d560957af0cc48da3a09f29e50",
};
export const hostIncognitoLifecycleInputHashes = {
  "shared-m-2-DfdOu-fU.js":
    "d0037b48d11e1a8232b57ded7fb51992d39d1ddbed02a0a640cb2c47be586750",
};
// Keep this literal stable across minified/bundled verifier builds.
export const hostIncognitoLifecycleSource = `async function __claudexDiscardTemporaryConversation(state, readTemporary, readOrganization, finish) {
  const target = readTemporary();
  if (!target) { finish(); return; }
  const context = state.context;
  if (!state.active || typeof target.orgUuid !== "string" || !target.orgUuid || target.orgUuid !== context.orgUuid || target.orgUuid !== readOrganization()) return;
  if (state.pending) return;
  const attempt = { accountUuid: context.accountUuid, orgUuid: target.orgUuid, uuid: target.uuid };
  state.pending = attempt;
  const isCurrent = () => {
    const current = readTemporary();
    return state.active && state.pending === attempt &&
      state.context.accountUuid === attempt.accountUuid && state.context.orgUuid === attempt.orgUuid &&
      readOrganization() === attempt.orgUuid && current?.orgUuid === attempt.orgUuid && current?.uuid === attempt.uuid;
  };
  let succeeded = false;
  try {
    const response = await fetch(
      \`/api/organizations/\${encodeURIComponent(attempt.orgUuid)}/chat_conversations/\${encodeURIComponent(attempt.uuid)}/discard_incognito\`,
      { method: "POST" },
    );
    if (!isCurrent()) return;
    if (response.status !== 204) throw new Error("Incognito cleanup failed");
    succeeded = true;
  } catch {
    if (isCurrent()) state.context.addError(state.context.intl.formatMessage({
      defaultMessage: "Something went wrong", id: "JqiqNj0Ooi",
    }));
  } finally {
    const finishCurrent = succeeded && isCurrent();
    if (state.pending === attempt) state.pending = null;
    if (finishCurrent) finish();
  }
}
`;
export const hostIncognitoLifecycleRules = [
  {
    file: "shared-m-2-DfdOu-fU.js",
    name: "original-temporary-route-parser",
    before: "  o1,\n  oO,\n",
    after: "  o1,\n  o8 as __claudexIncognitoRouteUuid,\n  oO,\n",
  },
  {
    file: "shared-m-2-DfdOu-fU.js",
    name: "incognito-exit-owner-context",
    before: "    { activeOrganization: n } = E_(),\n    r = nu(n?.uuid),",
    after:
      "    { account: __claudexIncognitoAccount, activeOrganization: n } = E_(),\n    __claudexIncognitoErrors = Re(),\n    __claudexIncognitoIntl = gy(),\n    __claudexIncognitoExit = nu({ active: true, pending: null, context: null }),\n    r = nu(n?.uuid),",
  },
  {
    file: "shared-m-2-DfdOu-fU.js",
    name: "incognito-exit-live-owner",
    before: "    o = J1($, 2, a) ? K1($, 2, a, [a]) : $[3];\n  sQ(i, o);",
    after:
      "    o = J1($, 2, a) ? K1($, 2, a, [a]) : $[3];\n  const __claudexPreviousIncognitoOwner = __claudexIncognitoExit.current.context;\n  if (__claudexPreviousIncognitoOwner && (\n    __claudexPreviousIncognitoOwner.accountUuid !== __claudexIncognitoAccount?.uuid ||\n    __claudexPreviousIncognitoOwner.orgUuid !== n?.uuid\n  )) __claudexIncognitoExit.current.pending = null;\n  __claudexIncognitoExit.current.context = {\n    accountUuid: __claudexIncognitoAccount?.uuid, orgUuid: n?.uuid,\n    addError: __claudexIncognitoErrors.addError, intl: __claudexIncognitoIntl,\n  };\n  sQ(() => {\n    __claudexIncognitoExit.current.active = true;\n    return () => {\n      __claudexIncognitoExit.current.active = false;\n      __claudexIncognitoExit.current.pending = null;\n    };\n  }, []);\n  sQ(i, o);",
  },
  {
    file: "shared-m-2-DfdOu-fU.js",
    name: "await-explicit-incognito-exit",
    before:
      '  let F = J2($, 22, M, s)\n      ? K2($, 22, M, s, (e) => {\n          if (!(e && (_a() || q8() || $M())) && !(!e && M())) {\n            if (!e && [window.location.pathname, N3()].some(QQ)) {\n              (_(null), wK(s, "/new", "page_control"));\n              return;\n            }\n            if ((e && pg(), m(e), _(null), e)) s.push(`?${JI}`);\n            else {\n              let e = new URLSearchParams(window.location.search);\n              e.delete(JI);\n              let t = e.toString();\n              s.push(`${window.location.pathname}${t ? `?${t}` : ""}`, void 0);\n            }\n          }\n        })\n      : $[24],\n',
    after:
      '  let F = J2($, 22, M, s)\n      ? K2($, 22, M, s, async (e) => {\n          if (!(e && (_a() || q8() || $M())) && !(!e && M())) {\n            const __claudexFinishIncognitoExit = () => {\n            if (!e && [window.location.pathname, N3()].some(QQ)) {\n              (_(null), wK(s, "/new", "page_control"));\n              return;\n            }\n            if ((e && pg(), m(e), _(null), e)) s.push(`?${JI}`);\n            else {\n              let e = new URLSearchParams(window.location.search);\n              e.delete(JI);\n              let t = e.toString();\n              s.push(`${window.location.pathname}${t ? `?${t}` : ""}`, void 0);\n            }\n            };\n            if (e !== false) return __claudexFinishIncognitoExit();\n            return await __claudexDiscardTemporaryConversation(\n              __claudexIncognitoExit.current, () => {\n                const saved = H5();\n                if (saved) return saved;\n                const uuid = __claudexIncognitoRouteUuid(window.location.pathname);\n                return uuid && gj(uuid) && RZ(new URLSearchParams(window.location.search))\n                  ? { uuid, orgUuid: r.current } : null;\n              }, () => r.current, __claudexFinishIncognitoExit,\n            );\n          }\n        })\n      : $[24],\n',
  },
];
const sha = (source) => createHash("sha256").update(source).digest("hex");
export function deriveOfficialUiHostIncognitoLifecycleModule(file, source) {
  if (!Object.hasOwn(hostIncognitoLifecycleInputHashes, file)) return source;
  if (sha(source) !== hostIncognitoLifecycleInputHashes[file])
    throw Error("Pinned incognito lifecycle input mismatch: " + file);
  let result = source;
  for (const rule of hostIncognitoLifecycleRules.filter(
    (rule) => rule.file === file,
  )) {
    const at = result.indexOf(rule.before);
    if (at < 0 || result.indexOf(rule.before, at + rule.before.length) >= 0)
      throw Error("Pinned incognito lifecycle anchor mismatch: " + rule.name);
    result =
      result.slice(0, at) + rule.after + result.slice(at + rule.before.length);
  }
  return hostIncognitoLifecycleSource + result;
}
export function applyOfficialUiHostIncognitoLifecycle(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const rows = Object.keys(hostIncognitoLifecycleInputHashes).map((file) => {
    const location = path.join(directory, file);
    if (fs.lstatSync(location).isSymbolicLink())
      throw Error("Incognito lifecycle output symlink rejected");
    const source = fs.readFileSync(location, "utf8");
    return {
      file,
      location,
      source,
      output: deriveOfficialUiHostIncognitoLifecycleModule(file, source),
    };
  });
  for (const row of rows) fs.writeFileSync(row.location, row.output);
  return {
    revision: hostIncognitoLifecycleRevision,
    modules: rows.map((row) => ({
      file: row.file,
      originalSha256: hostIncognitoLifecycleOriginalHashes[row.file],
      inputSha256: sha(row.source),
      outputSha256: sha(row.output),
      rules: hostIncognitoLifecycleRules
        .filter((rule) => rule.file === row.file)
        .map((rule) => rule.name),
    })),
  };
}
