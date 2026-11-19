import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const hostCodeAppScopeRevision = "claudex-code-app-scope-v1";
const code = "c63275c0a-B8KNacgV.js";
const renderer = "cd9b7fccf-CJwtdfve.js";
export const hostCodeAppScopeOriginalHashes = {
  [code]: "ee06822c56dec63732586e97bb431d9c151882ae85cc055e2694d0a5c690d00f",
  [renderer]: "240e4e1a7e1a30541519c81f6ed03b300f51f8dd0caa1376604f2c8da9f7b416",
};
export const hostCodeAppScopeInputHashes = {
  [code]: "8b1e5daec871d7e957637c8cccab2abb8749f549934afd03de424f05c0a8c134",
  [renderer]: "9cb465fbc4ef6e292417c276074c43d7c43fb914c8f88cc34a0543b2760cf2cd",
};
export const hostCodeAppScopeRules = [
  {
    file: code,
    name: "remember-code-app-tool-row",
    before: `function Fj(e) {\n  let $ = J9(556),`,
    after: `function Fj(e) {\n  let $ = J9(558),`,
  },
  {
    file: code,
    name: "invalidate-the-app-element-when-the-tool-row-changes",
    before: `    zo =
      J5(
        $,
        396,`,
    after: `    zo =
      J1($, 556, n.id) ||
      J5(
        $,
        396,`,
  },
  {
    file: code,
    name: "bind-the-app-element-to-its-code-row",
    before: `      J2($, 448, Gn?.resolveHostContextExtras, ae)
        ? I2(`,
    after: `      J2($, 448, Gn?.resolveHostContextExtras, ae)
        ? I1($, 556, I2(`,
  },
  {
    file: code,
    name: "pass-the-registered-code-app-origin",
    before: `                          client: O,
                          toolName: De,
                          toolResourceUri: $e,`,
    after: `                          client: O,
                          claudexCodeScope:
                            c?.id && /^(?:local_|session_|cse_)/.test(c.id) &&
                            g?.server.type === "remote" &&
                            n.name.startsWith("mcp__" + y + "__")
                              ? { sessionId: c.id, toolUseId: n.id }
                              : void 0,
                          toolName: De,
                          toolResourceUri: $e,`,
  },
  {
    file: code,
    name: "cache-the-code-app-origin-with-the-element",
    before: `            Gn?.resolveHostContextExtras,
            ae,
          )
        : $[450],`,
    after: `            Gn?.resolveHostContextExtras,
            ae,
          ), n.id)
        : $[557],`,
  },
  {
    file: renderer,
    name: "keep-the-app-origin-with-the-sandbox-bridge",
    before: `  let Un = J5($, 81, L, F, Ot, f, I, Dt)`,
    after: `  const readClaudexCodeScope = o(() => e.claudexCodeScope);
  let Un = J5($, 81, L, F, Ot, f, I, Dt)`,
  },
  {
    file: renderer,
    name: "send-the-host-supplied-app-origin",
    before: `                  n();
                  let r = () =>
                    l.request({ method: "tools/call", params: e }, { signal: t.mcpReq.signal });`,
    after: `                  n();
                  const scope = readClaudexCodeScope();
                  const params = scope
                    ? { ...e, _meta: { ...e._meta, claudex_code_scope: scope } }
                    : e;
                  let r = () =>
                    l.request({ method: "tools/call", params }, { signal: t.mcpReq.signal });`,
  },
];

const sha = (source) => createHash("sha256").update(source).digest("hex");

export function deriveOfficialUiHostCodeAppScopeModule(file, source) {
  if (!Object.hasOwn(hostCodeAppScopeInputHashes, file)) return source;
  if (sha(source) !== hostCodeAppScopeInputHashes[file])
    throw Error("Pinned Code App origin input mismatch: " + file);
  let output = source;
  for (const { file: target, name, before, after } of hostCodeAppScopeRules) {
    if (file !== target) continue;
    if (output.split(before).length !== 2)
      throw Error("Pinned Code App origin anchor mismatch: " + name);
    output = output.replace(before, after);
  }
  return output;
}

export function applyOfficialUiHostCodeAppScope(directory) {
  return {
    revision: hostCodeAppScopeRevision,
    modules: Object.keys(hostCodeAppScopeInputHashes).map((file) => {
      const location = path.join(directory, file);
      const output = deriveOfficialUiHostCodeAppScopeModule(file, fs.readFileSync(location, "utf8"));
      fs.writeFileSync(location, output);
      return {
        file,
        originalSha256: hostCodeAppScopeOriginalHashes[file],
        inputSha256: hostCodeAppScopeInputHashes[file],
        outputSha256: sha(output),
        rules: hostCodeAppScopeRules.filter((rule) => rule.file === file).map(({ name }) => name),
      };
    }),
  };
}
