import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { hostLaunchDraftRevision } from "../scripts/official-ui-host-launch-draft.mjs";

const root = process.env.CLAUDEX_OFFICIAL_UI_ROOT ?? "build/official-ui";
const read = (name: string) =>
  fs.readFileSync(path.join(root, "ui/assets/v1", name), "utf8");
const slice = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};

test("the original preview failure and pane queue carry the report separately from the draft", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.hostLaunchDraft.revision, hostLaunchDraftRevision);
  const preview = read("cf580efe9-DH872joD.js");
  const pane = read("c03935b01-C5mJBQhH.js");
  const pending: unknown[] = [];
  const submitToChat = vm.runInNewContext(
    "({" + slice(pane, "submitToChat: (e, n)", "clearPendingChatSubmit:") + "}).submitToChat",
    {
      r: () => false,
      o: undefined,
      hu: () => undefined,
      R: () => ({}),
      a: (update: (state: object) => { pendingChatSubmit: unknown }) =>
        pending.push(update({}).pendingChatSubmit),
    },
  );
  const source = slice(preview, "function Ri(", "var Bi =");
  await vm.runInNewContext(source + '\nzi("dev", { cwd: "/tmp", sessionId: "local_test", paneStore });', {
    F: { startFromConfig: async () => ({ error: "Fixture process exited." }) },
    R: { getState: () => ({ openLoading() {}, serverReady() {} }) },
    Z: () => false,
    $n: (message: string) => message,
    paneStore: { getState: () => ({ currentSessionId: "local_test", submitToChat }) },
  });
  submitToChat("Ordinary imperative text");
  assert.deepEqual(JSON.parse(JSON.stringify(pending)), [
    { text: "Fixture process exited.", claudexLaunchReport: true },
    "Ordinary imperative text",
  ]);
});

test("the original Code composer sends only the explicit launch report after its preflight", async () => {
  const composer = read("cc43287c9-BDrqHHqn.js");
  assert.match(composer, /s\(\$re\(e\), \{ claudexLaunchReport: true \}\)/);
  const source = slice(composer, 'if (!(await Qm("composer"))) return;', "let je = PR(");
  for (const mode of ["ok", "error", "refused", "retired", "ordinary"] as const) {
    const reports: unknown[] = [];
    const notices: string[] = [];
    const outcome = await vm.runInNewContext("(async () => {" + source + 'return "ordinary";})()', {
      Qm: async (kind: string) => { assert.equal(kind, "composer"); return mode !== "refused"; },
      n: mode === "ordinary" ? undefined : { claudexLaunchReport: true },
      Y: () => ({ id: "local_test", type: "local" }),
      mr: () => mode !== "retired",
      Xe: () => 3,
      ee: 3,
      e: "Fixture process exited.",
      M: (notice: string) => notices.push(notice),
      g$: ({ hasPickedModel }: { hasPickedModel: boolean }) => hasPickedModel,
      Z: { hasPickedModel: true, modelId: "fixture-model", text: "Unsent draft", attachments: ["unsent.txt"] },
      X: { model: "other" },
      Ik: { getState: () => ({ buckets: {} }) },
      LV: () => true,
      pA: () => false,
      lM: () => false,
      qu: async (report: unknown) => {
        reports.push(report);
        if (mode === "error") throw Error("Fixture transport rejected the report.");
      },
      crypto: { randomUUID: () => "fixture-report-id" },
      te: 1,
      ca: () => "later",
      ru: { ccdSteering: true },
    });
    if (mode === "ok" || mode === "error") {
      assert.deepEqual(JSON.parse(JSON.stringify(reports)), [{
        ref: { id: "local_test", type: "local" },
        text: "Fixture process exited.", uuid: "fixture-report-id", movesAtSend: 1,
        model: "fixture-model", priority: "later", steeringGates: { ccdSteering: true },
        remoteRejectionCard: true, dispatchFirst: true,
      }]);
      assert.equal(notices.length, mode === "error" ? 1 : 0);
    } else {
      assert.deepEqual(reports, []);
    }
    assert.equal(outcome, mode === "ordinary" ? "ordinary" : undefined);
  }
});
