import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hostAuthenticatedExpression } from "./official-ui-host-auth.mjs";
export const hostSkillSearchRevision = "claudex-installed-skill-search-v5";
export const hostSkillSearchInputHashes = {
  "c5e558aae-38ebsbqD.js":
    "b9778221a1a2cc1d957937561f9d588ba20c7d740ec1ee5be4b285a7f3f8668d",
};
export const hostSkillSearchOriginalHashes = {
  "c5e558aae-38ebsbqD.js":
    "4f6e314257c58f2f4dced25d6efdaaf2973cfdc4fb6641e150852b766c8fdfd2",
};
// Canonical literal: derivation must be byte-identical after build-tool bundling.
export const hostSkillSearchModeSource = `function __claudexInstalledSkillSearchMode(unified,context,tab) {
 const e=context?.account;
 return tab === "mine" && ${hostAuthenticatedExpression} && typeof context?.activeOrganization?.uuid === "string" && context.activeOrganization.uuid.length > 0 ? false : unified;
}
function __claudexWebSkillAccount(context, frame) {
  return frame && !__claudexInstalledSkillSearchMode(true, context, "mine") &&
    frame.accountUuid === context.account.uuid &&
    frame.orgUuid === context.activeOrganization.uuid
    ? context.account : void 0;
}
`;
export const hostSkillSearchRules = [
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "host-yours-original-library-search",
    before: "      M = ze(),\n      Ae = J1($, 3, M)",
    after: `      __claudexSkillSearchContext = __claudexSkillSearchAccount(),
      M = __claudexInstalledSkillSearchMode(ze(), __claudexSkillSearchContext, D),
      __claudexYoursCatalog = __claudexInstalledSkillSearchMode(Tn, __claudexSkillSearchContext, D),
      __claudexSkillsFrame = typeof window === "undefined" ? void 0 : window.__claudexOfficialAccountContext,
      __claudexReadOnlyYours =
        !__claudexYoursCatalog &&
        __claudexSkillsFrame?.accountUuid === __claudexSkillSearchContext?.account?.uuid &&
        __claudexSkillsFrame?.orgUuid === __claudexSkillSearchContext?.activeOrganization?.uuid,
      Ae = J1($, 3, M)`,
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "host-yours-search-preserves-list-context",
    before: "    kt(N && !M, L);",
    after: "    kt(N && !M && __claudexInstalledSkillSearchMode(true, __claudexSkillSearchContext, D), L);",
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "host-yours-search-catalog-memo-slot",
    before: "  On = a(function (e) {\n    let $ = J9(324),",
    after: "  On = a(function (e) {\n    let $ = J9(325),",
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "host-yours-search-uses-only-installed-results",
    before: `      Dr = J5($, 210, Dt, O, Ke, qe, j, Fe, e, P)
        ? K5(
            $,
            210,
            Dt,
            O,
            Ke,
            qe,
            j,
            Fe,
            e,
            P,
            i(jt, {
              search: j,
              section: "skills",
              yours: P,
              yoursRows: e,
              catalogCapable: Tn,
              includePluginRows: qe,
              overlay: Dt,
              pluginInstall: Ke,
              skillAdd: Fe,
              onOpenItem: O,
            }),
          )
        : $[218];`,
    after: `      Dr = J5($, 210, Dt, O, Ke, qe, j, Fe, e, P) || J1($, 324, __claudexYoursCatalog)
        ? Z1($, 324, K5(
            $,
            210,
            Dt,
            O,
            Ke,
            qe,
            j,
            Fe,
            e,
            P,
            i(jt, {
              search: j,
              section: "skills",
              yours: P,
              yoursRows: e,
              catalogCapable: __claudexYoursCatalog,
              includePluginRows: qe,
              overlay: Dt,
              pluginInstall: Ke,
              skillAdd: Fe,
              onOpenItem: O,
            }),
          ), __claudexYoursCatalog)
        : $[218];`,
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "web-yours-empty-card-omits-discover",
    before: "    let pr = nr,",
    after: "    let pr = __claudexReadOnlyYours ? void 0 : nr,",
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "web-yours-empty-card-uses-stock-no-skills-copy",
    before: "              headline: dr,\n              description: fr,\n              art: vn,",
    after: `              headline: __claudexReadOnlyYours
                ? i(A, { defaultMessage: "Your skills", id: "7Ktj7z" })
                : dr,
              description: __claudexReadOnlyYours
                ? i(A, {
                    defaultMessage:
                      "{kind, select, plugins {No plugins found.} skills {No skills found.} other {No connectors found.}}",
                    id: "/vbo18",
                    values: { kind: "skills" },
                  })
                : fr,
              art: vn,`,
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "web-yours-enables-authoring-for-the-active-host-account",
    before: "      _r = Ne(),\n      vr = ke(),",
    after: `      _r = Ne(),
      __claudexOriginalAddSkill = ke(),
      vr = __claudexReadOnlyYours
        ? __claudexWebSkillAccount(__claudexSkillSearchContext, __claudexSkillsFrame)?.claudex_skill_upload === true ||
          __claudexSkillSearchContext?.account?.claudex_skill_creation === true
        : __claudexOriginalAddSkill,`,
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "web-skill-author-menu-uses-supported-actions",
    before: `    d = J1($, 1, c) ? K1($, 1, c, i(s.Item, { onClick: c, icon: "Upload", children: u })) : $[2],
    f = J0($, 3) ? K0($, 3, i(A, { defaultMessage: "Create a skill", id: "oSuR6W" })) : $[3],
    p = J1($, 4, o) ? K1($, 4, o, i(s.Item, { onClick: o, icon: "Edit", children: f })) : $[5],`,
    after: `    __claudexUploadContext = __claudexSkillSearchAccount(),
    __claudexAuthorFrame = typeof window !== "undefined" && window.__claudexOfficialAccountContext,
    __claudexUploadAccount = __claudexWebSkillAccount(__claudexUploadContext, __claudexAuthorFrame),
    __claudexCanUpload = !__claudexAuthorFrame || __claudexUploadAccount?.claudex_skill_upload === true,
    __claudexCanCreate = !__claudexAuthorFrame || __claudexUploadAccount?.claudex_skill_creation === true,
    __claudexUploadAction = __claudexCanUpload ? c : void 0,
    __claudexCreateAction = __claudexCanCreate ? o : void 0,
    d = J1($, 1, __claudexUploadAction)
      ? K1($, 1, __claudexUploadAction, __claudexUploadAction && i(s.Item, { onClick: __claudexUploadAction, icon: "Upload", children: u }))
      : $[2],
    f = J0($, 3) ? K0($, 3, i(A, { defaultMessage: "Create a skill", id: "oSuR6W" })) : $[3],
    p = J1($, 4, __claudexCreateAction)
      ? K1($, 4, __claudexCreateAction, __claudexCreateAction && i(s.Item, { onClick: __claudexCreateAction, icon: "Edit", children: f }))
      : $[5],`,
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "web-skill-toolbar-allows-upload-without-creation",
    before: '      _ = ne("skill_creation").isAvailable,',
    after: `      __claudexUploadContext = __claudexSkillSearchAccount(),
      __claudexAuthorFrame = typeof window !== "undefined" && window.__claudexOfficialAccountContext,
      _ = ne("skill_creation").isAvailable ||
        __claudexWebSkillAccount(__claudexUploadContext, __claudexAuthorFrame)?.claudex_skill_upload === true,`,
  },
  {
    file: "c5e558aae-38ebsbqD.js",
    name: "web-skill-upload-page-uses-active-account-capability",
    before: '    Wt = g.kind === "upload" && nt && it && at,',
    after: `    __claudexSkillUploadAccount = __claudexSkillSearchAccount(),
    __claudexSkillUploadFrame = typeof window !== "undefined" && window.__claudexOfficialAccountContext,
    Wt = g.kind === "upload" && (__claudexSkillUploadFrame
      ? __claudexWebSkillAccount(__claudexSkillUploadAccount, __claudexSkillUploadFrame)?.claudex_skill_upload === true
      : nt && it && at),`,
  },
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function deriveOfficialUiHostSkillSearchModule(file, source) {
  if (!Object.hasOwn(hostSkillSearchInputHashes, file)) return source;
  if (sha(source) !== hostSkillSearchInputHashes[file])
    throw Error("Pinned installed-skill search input mismatch: " + file);
  let output = source;
  for (const rule of hostSkillSearchRules.filter(
    (rule) => rule.file === file,
  )) {
    const at = output.indexOf(rule.before);
    if (at < 0 || output.indexOf(rule.before, at + rule.before.length) >= 0)
      throw Error(
        "Pinned installed-skill search anchor mismatch: " + rule.name,
      );
    output =
      output.slice(0, at) + rule.after + output.slice(at + rule.before.length);
  }
  return (
    'import {ce as __claudexSkillSearchAccount} from "./shared-l-p-m-w-2-BMCa56Vr.js";\n' +
    hostSkillSearchModeSource +
    output
  );
}
export function applyOfficialUiHostSkillSearch(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const rows = Object.keys(hostSkillSearchInputHashes).map((file) => {
    const location = path.join(directory, file);
    if (fs.lstatSync(location).isSymbolicLink())
      throw Error("Installed-skill search output symlink rejected");
    const input = fs.readFileSync(location, "utf8"),
      output = deriveOfficialUiHostSkillSearchModule(file, input);
    return { file, location, input, output };
  });
  for (const row of rows) fs.writeFileSync(row.location, row.output);
  return {
    revision: hostSkillSearchRevision,
    modules: rows.map((row) => ({
      file: row.file,
      originalSha256: hostSkillSearchOriginalHashes[row.file],
      inputSha256: sha(row.input),
      outputSha256: sha(row.output),
      rules: hostSkillSearchRules
        .filter((rule) => rule.file === row.file)
        .map((rule) => rule.name),
    })),
  };
}
