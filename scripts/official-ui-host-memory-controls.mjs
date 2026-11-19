import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const shared = "shared-0-BgsOqC85.js";
const editor = "cffc9ea71-B7zNZ9tc.js";
const account = "c953053b7-DrQ3In9z.js";

export const hostMemoryControlsRevision =
  "original-memory-controls-reset-fence-v1";
export const hostMemoryControlsOriginalHashes = {
  [shared]: "51ea5a9194e05ac89c14f18c3943a94769bb3de50ccf63d4737b4dd01bfd99c4",
  [editor]: "e7fbb89aaee469e9643cb3539126f6a9d83367e15dd3a1c4346ec494a58178f0",
  [account]: "8082b9a3b939a2e2ed8eff99b1cc62d62212c414b5ed3d255db0f3508a8194e9",
};
export const hostMemoryControlsInputHashes = {
  [shared]: "e26abd6e4cfee614061b69e1e06289efce3da4f42fa1b440eabf6ee7b0f8729d",
  [editor]: "350e1f96c3ad3561751bd174f96babf250e5b990aca56850dbc019ec40829b68",
  [account]: "5bbe2de846c9715f770a72d54cd5b04b9b0332547ee7bd5f118b3922d84b1226",
};

const rule = (file, name, before, after) => ({ file, name, before, after });
export const hostMemoryControlsRules = [
  rule(
    shared,
    "keep-editor-reset-lineage",
    `          let o = r(),
            s = o ? (o.controls ?? []) : void 0,
            c;
          try {`,
    `          let o = r(),
            s = o ? (o.controls ?? []) : void 0,
            c;
          const lineage = (version) => version?.split(":").slice(0, 3).join(":");
          if (Object.hasOwn(e, "editedFromVersion") &&
              lineage(e.editedFromVersion) !== lineage(o?.controls_version))
            throw Object.assign(new Error("Memory was reset."), { code: "memory_reset_since_read" });
          try {`,
  ),
  rule(
    shared,
    "merge-within-reset-lineage",
    `          if (!l.controls_version) throw c;
          let u = l.controls ?? [],`,
    `          if (!l.controls_version || lineage(l.controls_version) !== lineage(o?.controls_version)) throw c;
          let u = l.controls ?? [],`,
  ),
  rule(
    editor,
    "preview-editor-version",
    `function w(e) {
  let $ = J9(25),`,
    `function w(e) {
  let $ = J9(26),`,
  ),
  rule(
    editor,
    "preview-version-cache-key",
    "J5($, 16, s, S, g, _, n, o, y, x)",
    "J5($, 16, s, S, g, _, n, o, y, x, m?.controls_version)",
  ),
  rule(
    editor,
    "preview-version-cache-slot",
    `          y,
          x,
          n === "synthesis"`,
    `          y,
          x,
          m?.controls_version,
          n === "synthesis"`,
  ),
  rule(
    editor,
    "preview-version-cache-result",
    "      : $[24]\n  );\n}\nfunction T(e)",
    "      : $[25]\n  );\n}\nfunction T(e)",
  ),
  rule(
    editor,
    "preview-add-version",
    "                          memoryControls: _ ?? void 0,",
    "                          memoryControls: _ ?? void 0,\n                          memoryControlsVersion: m?.controls_version,",
  ),
  rule(
    editor,
    "preview-manage-version",
    "                  edits: _ ?? void 0,",
    "                  edits: _ ?? void 0,\n                  memoryControlsVersion: m?.controls_version,",
  ),
  rule(
    editor,
    "add-draft-state",
    `  let $ = J9(62),
    { memoryControls: a, updateMemoryControls: s, updateMemoryControlsIsPending: u, inline: p } = e,`,
    `  let $ = J9(72),
    { memoryControls: a, memoryControlsVersion, updateMemoryControls: s, updateMemoryControlsIsPending: u, inline: p } = e,`,
  ),
  rule(
    editor,
    "add-draft-text",
    '    [b, x] = t(""),',
    '    [draft, x] = t(null),\n    b = draft?.text ?? "",',
  ),
  rule(
    editor,
    "add-draft-submit",
    `    O = J4($, 2, b, h, C, s)
      ? K4($, 2, b, h, C, s, () => {`,
    `    O = J4($, 2, draft, h, C, s)
      ? K4($, 2, draft, h, C, s, () => {`,
  ),
  rule(
    editor,
    "add-draft-base",
    `              editedFrom: h,
            }),
            x(""));`,
    `              editedFrom: h,
              editedFromVersion: draft.version,
            }),
            x(null));`,
  ),
  rule(
    editor,
    "capture-add-version-on-input",
    `      d,
      p;
    $[12] === J8
      ? ((p = (e) => x(e.target.value)), (d = () => D(!0)), ($[12] = d), ($[13] = p))
      : ((d = $[12]), (p = $[13]));`,
    `      d = J0($, 12) ? K0($, 12, () => D(!0)) : $[12],
      p = J1($, 62, memoryControlsVersion)
        ? K1($, 62, memoryControlsVersion, (e) => {
            const text = e.target.value;
            x((draft) => text ? { text, version: draft ? draft.version : memoryControlsVersion } : null);
          })
        : $[63];`,
  ),
  rule(
    editor,
    "input-receives-current-baseline-handler",
    `      C = J5($, 21, b, u, T, m, g, v)
        ? K5(
            $,
            21,
            b,
            u,
            T,
            m,
            g,
            v,`,
    `      C = J5($, 64, b, u, T, m, g, v, p)
        ? K5(
            $,
            64,
            b,
            u,
            T,
            m,
            g,
            v,
            p,`,
  ),
  rule(
    editor,
    "input-handler-cache-slot",
    `          )
        : $[27],
      w = J2($, 28, y, k)`,
    `          )
        : $[71],
      w = J2($, 28, y, k)`,
  ),
  rule(
    editor,
    "manage-edits-baseline",
    "    [g] = t(l),",
    "    [g] = t({ controls: l, version: e.memoryControlsVersion }),",
  ),
  rule(
    editor,
    "manage-edits-submit",
    "s({ controls: _, editedFrom: g })",
    "s({ controls: _, editedFrom: g.controls, editedFromVersion: g.version })",
  ),
  rule(
    account,
    "account-clear-baseline",
    `      b = J2($, 7, y, u)
        ? K2($, 7, y, u, () => {
            y({ controls: [], editedFrom: u ?? [] });`,
    `      b = J2($, 7, y, s)
        ? K2($, 7, y, s, () => {
            y({ controls: [], editedFrom: u ?? [], editedFromVersion: s?.controls_version });`,
  ),
  rule(
    account,
    "account-remove-baseline",
    `      x = J2($, 10, u, _)
        ? K2($, 10, u, _, (e) => {
            let t = u ?? [];
            _({ controls: t.filter((t, n) => n !== e), editedFrom: t });`,
    `      x = J2($, 10, s, _)
        ? K2($, 10, s, _, (e) => {
            let t = u ?? [];
            _({ controls: t.filter((t, n) => n !== e), editedFrom: t, editedFromVersion: s?.controls_version });`,
  ),
  rule(
    account,
    "account-add-baseline",
    `      j = J3($, 36, y, A, v)
        ? K3(
            $,
            36,
            y,
            A,
            v,
            o(at, {
              inline: !0,
              memoryControls: A,`,
    `      j = J3($, 36, y, s, v)
        ? K3(
            $,
            36,
            y,
            s,
            v,
            o(at, {
              inline: !0,
              memoryControls: A,
              memoryControlsVersion: s?.controls_version,`,
  ),
];

const sha = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiHostMemoryControlsModule(file, source) {
  if (!Object.hasOwn(hostMemoryControlsInputHashes, file)) return source;
  if (sha(source) !== hostMemoryControlsInputHashes[file])
    throw Error("Pinned memory controls input mismatch: " + file);
  for (const { name, before, after } of hostMemoryControlsRules.filter(
    (rule) => rule.file === file,
  )) {
    if (source.split(before).length !== 2)
      throw Error("Pinned memory controls anchor mismatch: " + name);
    source = source.replace(before, () => after);
  }
  return source;
}

export function applyOfficialUiHostMemoryControls(directory) {
  const modules = Object.entries(hostMemoryControlsInputHashes).map(
    ([file, inputSha256]) => {
      const target = path.join(directory, file);
      const output = deriveOfficialUiHostMemoryControlsModule(
        file,
        fs.readFileSync(target, "utf8"),
      );
      return {
        target,
        output,
        record: {
          file,
          originalSha256: hostMemoryControlsOriginalHashes[file],
          inputSha256,
          outputSha256: sha(output),
          rules: hostMemoryControlsRules
            .filter((rule) => rule.file === file)
            .map((rule) => rule.name),
        },
      };
    },
  );
  for (const { target, output } of modules) fs.writeFileSync(target, output);
  return {
    revision: hostMemoryControlsRevision,
    modules: modules.map(({ record }) => record),
  };
}
