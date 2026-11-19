import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const lifecycle = "shared-m-2-DfdOu-fU.js";
const uploader = "shared-m-1-Nm0kn4Ee.js";
const fallback = "shared-3-f8anTwq9.js";
const inputs = {
  [lifecycle]: "65b43cd28c555a0d063f2f3e6e7d55763fd956e4566d52f4d46636b6e62c2143",
  [uploader]: "35709256161ff9ce70f2c06409e7409be97ec3d244a105be9a3af44c53e8df63",
  [fallback]: "d33dd2a6806760b7b73387d367a8b7cfd871b3e27322c08a310dcff1d214b03e",
};
const key = "claudex_incognito_draft";
const sha = source => createHash("sha256").update(source).digest("hex");
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw Error("Incognito upload anchor mismatch");
  return source.replace(before, after);
}
export function deriveOfficialIncognitoUploads(name, source) {
  if (!Object.hasOwn(inputs, name)) return source;
  if (sha(source) !== inputs[name]) throw Error("Incognito upload input mismatch: " + name);
  if (name === fallback) {
    source = replace(source,
      '    let s = vh(t) + (i ? OR : "");',
      '    let s = vh(t) + (i ? OR : "");\n    window.__claudexMarkIncognitoUpload?.(s, a);');
    return replace(source,
      '        let s = i ? `/api/organizations/${r}/projects/${i}/upload` : `/api/${r}/upload`,\n          c = await e(s, { method: "POST", body: o, signal: a });',
      '        let s = i ? `/api/organizations/${r}/projects/${i}/upload` : `/api/${r}/upload`;\n        window.__claudexMarkIncognitoUpload?.(s, o);\n        const c = await e(s, { method: "POST", body: o, signal: a });');
  }
  if (name === uploader) {
    return replace(source,
      '    W3(a, r?.clientUploadId),',
      '    window.__claudexMarkIncognitoUpload?.(t, a),\n    W3(a, r?.clientUploadId),');
  }
  source = replace(source,
    'const attempt = { accountUuid: context.accountUuid, orgUuid: target.orgUuid, uuid: target.uuid };',
    'const attempt = { accountUuid: context.accountUuid, orgUuid: target.orgUuid, uuid: target.uuid, draftId: target.draftId };');
  source = replace(source,
    '{ method: "POST" },',
    '{ method: "POST", ...(attempt.draftId ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: attempt.draftId }) } : {}) },');
  source = replace(source,
    'if (finishCurrent) finish();',
    'if (finishCurrent) { if (attempt.draftId) pY().removeItem("' + key + '"); finish(); }');
  source = replace(source,
    'if (!(e && (_a() || q8() || $M())) && !(!e && M())) {',
    'const explicitPrivateRoute = RZ(new URLSearchParams(location.search)) && !!__claudexIncognitoRouteUuid(location.pathname);\n          if (!(e && (_a() || q8() || $M())) && !(!e && M() && !explicitPrivateRoute)) {');
  source = replace(source,
    '                const saved = H5();\n                if (saved) return saved;\n                const uuid = __claudexIncognitoRouteUuid(window.location.pathname);\n                return uuid && gj(uuid) && RZ(new URLSearchParams(window.location.search))\n                  ? { uuid, orgUuid: r.current } : null;',
    '                const saved = H5();\n                const draftId = __claudexPrivateDraft(r.current, false);\n                if (saved) return { ...saved, draftId };\n                const uuid = __claudexIncognitoRouteUuid(window.location.pathname);\n                if (uuid && gj(uuid) && RZ(new URLSearchParams(window.location.search))) return { uuid, orgUuid: r.current, draftId };\n                return draftId ? { uuid: draftId, orgUuid: r.current, draftId } : null;');
  return source + `
function __claudexPrivateDraft(org, create) {
  if (!org) return;
  const storage = pY();
  let prior;
  try { prior = JSON.parse(storage.getItem("${key}") ?? "null"); } catch {}
  if (prior?.org === org && typeof prior.id === "string") return prior.id;
  if (!create) return;
  const id = crypto.randomUUID();
  storage.setItem("${key}", JSON.stringify({ org, id }));
  return id;
}
window.__claudexMarkIncognitoUpload = (address, form) => {
  const url = new URL(address, location.origin);
  const match = /^\\/api\\/([a-f0-9-]{36})\\/upload$/i.exec(url.pathname);
  if (url.origin !== location.origin || !match) return;
  const route = __claudexIncognitoRouteUuid(location.pathname), saved = H5();
  const active = ((location.pathname === "/new" || !!route) && RZ(new URLSearchParams(location.search))) ||
    (!!route && saved?.orgUuid === match[1] && saved.uuid === route);
  if (active) form.set("${key}", __claudexPrivateDraft(match[1], true));
};
`;
}

export function applyOfficialIncognitoUploads(directory) {
  const rows = Object.keys(inputs).map(name => {
    const file = path.join(directory, name);
    return { file, name, source: deriveOfficialIncognitoUploads(name, fs.readFileSync(file, "utf8")) };
  });
  for (const row of rows) fs.writeFileSync(row.file, row.source);
  return Object.fromEntries(rows.map(({ name, source }) => [name, sha(source)]));
}
