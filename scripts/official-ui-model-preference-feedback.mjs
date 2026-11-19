/** Reconcile failed model preferences with authoritative state and original error feedback. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const modelPreferenceFeedbackRevision =
  "original-model-preference-feedback-v1";
export const modelPreferenceFeedbackTarget = "shared-0-BgsOqC85.js";
export const modelPreferenceFeedbackInput =
  "9a15e991acb7930e5e25b15a453f285cda7c41a98539ed651d154c190da4ca74";
export const modelPreferenceFeedbackOutput =
  "e26abd6e4cfee614061b69e1e06289efce3da4f42fa1b440eabf6ee7b0f8729d";
export const modelPreferenceFeedbackRules = [
  {
    before: "function qO(e) {\n  let $ = J9(98),",
    after:
      "function qO(e) {\n  const claudexModelPreferenceNotices = bek(),\n    claudexModelPreferenceNoticeRef = tf({ notify: claudexModelPreferenceNotices.addApiError, active: !1, waiting: new Set() });\n  claudexModelPreferenceNoticeRef.current.notify = claudexModelPreferenceNotices.addApiError;\n  let $ = J9(98),",
  },
  {
    before: "    S = !!s,\n    C;\n  J5($, 13, r, y, v, n, o, t, S, h)",
    after:
      "    S = !!s,\n    C;\n  OW(() => {\n    claudexModelPreferenceNoticeRef.current.active = !0;\n    return () => {\n      claudexModelPreferenceNoticeRef.current.active = !1;\n      for (const cancel of claudexModelPreferenceNoticeRef.current.waiting) cancel();\n    };\n  }, [h]);\n  J5($, 13, r, y, v, n, o, t, S, h)",
  },
  {
    before:
      '        onError(e, i, a, o) {\n          let s = a?.previousValue?.model_selector_state?.find((e) => e.id === t);\n          if (\n            (s &&\n              U9(i) &&\n              h$.get(i)?.scope === h &&\n              !BJ(o) &&\n              n.setQueryData(r, (e) => {\n                let n = e?.model_selector_state?.find((e) => e.id === t);\n                return n?.model === i.model && n?.extra_option === s.extra_option\n                  ? V6(e, {\n                      id: t,\n                      model: s.model,\n                      selection_source: s.selection_source,\n                      hub_default_model: s.hub_default_model,\n                      thinking: s.thinking,\n                    })\n                  : e;\n              }),\n            $n(e, i) && _(i, o))\n          ) {\n            g.current?.send({ extra_option: i.extra_option });\n            return;\n          }\n          "model" in i &&\n            rZ("failure", { error: e, surface: t, model: i.model, initiator: i.initiator });\n        },',
    after:
      '        onError(e, i, a, claudexModelPreferenceContext) {\n          let s = a?.previousValue?.model_selector_state?.find((e) => e.id === t);\n          if (\n            (s &&\n              U9(i) &&\n              h$.get(i)?.scope === h &&\n              !BJ(claudexModelPreferenceContext) &&\n              n.setQueryData(r, (e) => {\n                let n = e?.model_selector_state?.find((e) => e.id === t);\n                return n?.model === i.model && n?.extra_option === s.extra_option\n                  ? V6(e, {\n                      id: t,\n                      model: s.model,\n                      selection_source: s.selection_source,\n                      hub_default_model: s.hub_default_model,\n                      thinking: s.thinking,\n                    })\n                  : e;\n              }),\n            $n(e, i) && _(i, claudexModelPreferenceContext))\n          ) {\n            g.current?.send({ extra_option: i.extra_option });\n            return;\n          }\n          if (!U9(i) && ("model" in i || "thinking" in i) && claudexModelPreferenceNoticeRef.current.active && _(i, claudexModelPreferenceContext) && qt(e)) {\n            claudexModelPreferenceNoticeRef.current.notify(e, { genericIfHidden: !0 });\n            const claudexModelPreferenceCache = n.getMutationCache(),\n              claudexModelPreferenceWaiting = claudexModelPreferenceNoticeRef.current.waiting;\n            let claudexModelPreferenceUnsubscribe;\n            const claudexModelPreferenceCancel = () => {\n              claudexModelPreferenceUnsubscribe?.();\n              claudexModelPreferenceWaiting.delete(claudexModelPreferenceCancel);\n            };\n            const claudexModelPreferenceSettle = () => {\n              if (!claudexModelPreferenceNoticeRef.current.active || !_(i, claudexModelPreferenceContext)) {\n                claudexModelPreferenceCancel();\n                return;\n              }\n              if (claudexModelPreferenceCache.findAll({ status: "pending" }).length !== 0) return;\n              claudexModelPreferenceCancel();\n              void o({ ambient: !0, cancelRefetch: !0 }).catch(() => {});\n            };\n            claudexModelPreferenceUnsubscribe = claudexModelPreferenceCache.subscribe(claudexModelPreferenceSettle);\n            claudexModelPreferenceWaiting.add(claudexModelPreferenceCancel);\n            claudexModelPreferenceSettle();\n          }\n          "model" in i &&\n            rZ("failure", { error: e, surface: t, model: i.model, initiator: i.initiator });\n        },',
  },
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function deriveOfficialModelPreferenceFeedbackModule(file, source) {
  if (file !== modelPreferenceFeedbackTarget) return source;
  if (
    typeof source !== "string" ||
    sha(source) !== modelPreferenceFeedbackInput
  )
    throw Error("Model preference feedback pinned input mismatch");
  let output = source;
  for (const rule of modelPreferenceFeedbackRules) {
    if (output.split(rule.before).length !== 2)
      throw Error("Model preference feedback anchor mismatch");
    output = output.replace(rule.before, rule.after);
  }
  if (sha(output) !== modelPreferenceFeedbackOutput)
    throw Error("Model preference feedback pinned output mismatch");
  return output;
}
const manifestFor = (outputSha256) => ({
  revision: modelPreferenceFeedbackRevision,
  modules: [
    {
      file: modelPreferenceFeedbackTarget,
      inputSha256: modelPreferenceFeedbackInput,
      outputSha256,
    },
  ],
});
export function applyOfficialModelPreferenceFeedback(directory) {
  const resolved = path.resolve(directory);
  if (
    fs.realpathSync(resolved) !== resolved ||
    resolved.split(path.sep).includes(".restore")
  )
    throw Error(
      "Model preference feedback requires an explicit unlinked assembly output",
    );
  const file = path.join(resolved, modelPreferenceFeedbackTarget);
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
    throw Error("Model preference feedback requires an unlinked module file");
  const value = deriveOfficialModelPreferenceFeedbackModule(
    modelPreferenceFeedbackTarget,
    fs.readFileSync(file, "utf8"),
  );
  fs.writeFileSync(file, value);
  return manifestFor(sha(value));
}
export function verifyOfficialModelPreferenceFeedbackManifest(
  manifest,
  files,
  outputSha256,
) {
  if (
    outputSha256 !== modelPreferenceFeedbackOutput ||
    JSON.stringify(manifest) !== JSON.stringify(manifestFor(outputSha256))
  )
    throw Error("Model preference feedback manifest mismatch");
  const rows = files.filter(
    (row) => row.path === "assets/v1/" + modelPreferenceFeedbackTarget,
  );
  if (rows.length !== 1 || rows[0].sha256 !== outputSha256)
    throw Error("Model preference feedback output mismatch");
}
