/** Preserve the composer while the original preview reports a launch failure. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const hostLaunchDraftRevision = "claudex-launch-report-draft-v1";
export const hostLaunchDraftInputHashes = {
  "cf580efe9-DH872joD.js": "ce3cf1da59099bdc38580731d260818b6d96d899136e73e35c6ddb06aa3d26f5",
  "c03935b01-C5mJBQhH.js": "934dfa7404090695c4fc1a3683c49c1f2ac4656df2469be21247fd6a0cf70af0",
  "cc43287c9-BDrqHHqn.js": "5f05855755a8efb3382ddcdcb94b471d3d2f49ab2cfea7c53e1fcea7f4b5f717"
};
export const hostLaunchDraftOriginalHashes = {
  "cf580efe9-DH872joD.js": "a75a94bc8e7484b537aecf243e34730d796f4620c70bea7732bb9402c212e2d4",
  "c03935b01-C5mJBQhH.js": "934dfa7404090695c4fc1a3683c49c1f2ac4656df2469be21247fd6a0cf70af0",
  "cc43287c9-BDrqHHqn.js": "8c2d97cb1dc34e2ecb2e1c6918bac434b698dee3833e447527b445b38509c03f"
};
export const hostLaunchDraftRules = [
  {
    "file": "cf580efe9-DH872joD.js",
    "name": "mark-explicit-launch-failure",
    "before": "o.getState().submitToChat($n(d.error))",
    "after": "o.getState().submitToChat($n(d.error), { claudexLaunchReport: true })"
  },
  {
    "file": "c03935b01-C5mJBQhH.js",
    "name": "carry-report-intent-with-pending-text",
    "before": "submitToChat: (e) => {\n        r(\"submitToChat\", [e], o, hu(e)) || a((t) => ({ pendingChatSubmit: e, ...R(t) }));\n      },",
    "after": "submitToChat: (e, n) => {\n        r(\"submitToChat\", n === undefined ? [e] : [e, n], o, hu(e)) || a((t) => ({\n          pendingChatSubmit: n?.claudexLaunchReport === true ? { text: e, claudexLaunchReport: true } : e,\n          ...R(t),\n        }));\n      },"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "consume-report-intent",
    "before": "r !== \"landing\" && t.current.submitMessage(d)",
    "after": "r !== \"landing\" && t.current.submitMessage(typeof d === \"string\" ? d : d.text, typeof d === \"string\" ? undefined : { claudexLaunchReport: d.claudexLaunchReport === true })"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "pass-report-options-to-composer",
    "before": "submitMessage: (e) => void _y(e, void 0, !1),",
    "after": "submitMessage: (e, n) => void _y(e, n?.claudexLaunchReport === true ? { claudexLaunchReport: true } : undefined, !1),"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "forward-report-options",
    "before": "submitMessage: (e) => ae.current?.submitMessage(e),",
    "after": "submitMessage: (e, n) => ae.current?.submitMessage(e, n),"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "mark-automatic-launch-failure",
    "before": "(e) => s($re(e))",
    "after": "(e) => s($re(e), { claudexLaunchReport: true })"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "send-report-after-original-preflight-without-consuming-draft",
    "before": "if (!(await Qm(\"composer\"))) return;",
    "after": "if (!(await Qm(\"composer\"))) return;\n                if (n?.claudexLaunchReport === true) {\n                  const reportSession = Y();\n                  if (!mr() || Xe() !== ee) return;\n                  if (reportSession?.type !== \"local\") {\n                    M(\"The launch error could not be sent to this Code session.\", {\n                      messageForLogging: \"Launch report has no current local session\",\n                    });\n                    return;\n                  }\n                  const pickedModel = g$({\n                    hasPickedModel: Z.hasPickedModel,\n                    modelId: Z.modelId,\n                    runningModel: X?.model,\n                    refusalFallbackArmed: Ik.getState().buckets[reportSession.id]?.refusalFallback != null,\n                  });\n                  const dispatchFirst = LV({\n                    refType: reportSession.type,\n                    wasMidTurn: pA(reportSession.id),\n                    sshAttachmentCount: 0,\n                    earlierSendInFlight: lM(reportSession.id),\n                  });\n                  try {\n                    await qu({\n                      ref: reportSession,\n                      text: e,\n                      uuid: crypto.randomUUID(),\n                      movesAtSend: te,\n                      model: pickedModel ? Z.modelId : undefined,\n                      priority: ca(reportSession, e, n.priority),\n                      steeringGates: ru,\n                      remoteRejectionCard: true,\n                      ...(dispatchFirst ? { dispatchFirst: true } : {}),\n                    });\n                  } catch (error) {\n                    if (mr() && Xe() === ee) M(\"The launch error could not be sent. Try again from this session.\", {\n                      messageForLogging: \"Launch report send failed\",\n                      error,\n                    });\n                  }\n                  return;\n                }"
  }
];
export function deriveOfficialUiLaunchDraftModule(file, source) {
  if (!Object.hasOwn(hostLaunchDraftInputHashes, file)) return source;
  if (createHash("sha256").update(source).digest("hex") !== hostLaunchDraftInputHashes[file])
    throw Error("Pinned launch draft input mismatch: " + file);
  let output = source;
  for (const rule of hostLaunchDraftRules.filter((row) => row.file === file)) {
    const at = output.indexOf(rule.before);
    if (at < 0 || output.indexOf(rule.before, at + rule.before.length) >= 0)
      throw Error("Pinned launch draft anchor mismatch: " + rule.name);
    output = output.slice(0, at) + rule.after + output.slice(at + rule.before.length);
  }
  return output;
}

/** Apply only to the assembled output copy; recovered source modules stay immutable. */
export function applyOfficialUiHostLaunchDraft(directory) {
  directory = fs.realpathSync(directory);
  if (directory.split(path.sep).includes(".restore"))
    throw Error("Recovered sources are immutable");
  const rows = Object.keys(hostLaunchDraftInputHashes).map((file) => {
    const location = path.join(directory, file);
    if (fs.lstatSync(location).isSymbolicLink())
      throw Error("Launch draft output must be a regular assembled file");
    const source = fs.readFileSync(location, "utf8");
    return { file, location, output: deriveOfficialUiLaunchDraftModule(file, source) };
  });
  for (const row of rows) fs.writeFileSync(row.location, row.output);
  return {
    revision: hostLaunchDraftRevision,
    modules: rows.map((row) => ({
      file: row.file,
      originalSha256: hostLaunchDraftOriginalHashes[row.file],
      inputSha256: hostLaunchDraftInputHashes[row.file],
      outputSha256: createHash("sha256").update(row.output).digest("hex"),
      rules: hostLaunchDraftRules.filter((rule) => rule.file === row.file).map((rule) => rule.name),
    })),
  };
}
