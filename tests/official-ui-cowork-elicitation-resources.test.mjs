import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { deriveOfficialUiHostCodeElicitationModule as derive } from "../scripts/official-ui-host-code-elicitation.mjs";

const root = path.join(process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted", "claude-frontend-4.4212.0/src/cloud/assets/v1");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("Cowork native elicitation keeps the original form and link controls and responses", async (t) => {
  if (!fs.existsSync(root)) return t.skip("Pinned original resources are unavailable");
  const shared = derive("shared-3-f8anTwq9.js", read("shared-3-f8anTwq9.js"));
  const start = shared.indexOf("function KH(e) {");
  const end = shared.indexOf("\nvar Ny =", start);
  assert.ok(start >= 0 && end > start);
  const project = vm.runInNewContext(`(${shared.slice(start, end).trim()})`);
  const form = { message: "Fixture", requestedSchema: { type: "object" }, fieldNames: [] };
  const link = { message: "Connect", href: "https://example.com/", host: "example.com" };
  const source = derive("ca44d5dae-Duwp3Ivb.js", read("ca44d5dae-Duwp3Ivb.js"));
  const begin = source.indexOf('      if (e.transport === "ipc" && e.isElicitation === !0');
  const finish = source.indexOf("      if (e.connectAsk !== void 0)", begin);
  assert.ok(begin >= 0 && finish > begin);
  const calls = [], answered = [];
  const render = vm.runInNewContext(`(e, claudexRespond) => { ${source.slice(begin, finish)} }`, {
    S: (component, props) => ({ component, props }),
    claudexElicitationForm: "form",
    claudexElicitationLink: "link",
    Promise,
  });
  for (const [kind, ask, result, decision] of [
    ["form", form, { action: "accept", content: { count: 3 } }, "once"],
    ["link", link, { action: "decline" }, "deny"],
  ]) {
    const raw = { sessionId: "session", requestId: kind, toolName: "fixture", input: {}, isElicitation: true,
      ...(kind === "form" ? { elicitationForm: ask } : { elicitationLink: ask }) };
    const request = project(raw);
    assert.equal(request.isElicitation, true);
    assert.deepEqual(request[kind === "form" ? "elicitationForm" : "elicitationLink"], ask);
    const card = render(request, (...args) => { calls.push(args); });
    assert.equal(card.component, kind);
    await card.props.decide(decision, undefined, { formResult: result, onAnswered: (ok) => answered.push(ok) });
    assert.deepEqual(calls.at(-1), [kind, kind, result, decision]);
  }
  assert.deepEqual(answered, [true, true]);
  const request = project({ sessionId: "session", requestId: "failed", toolName: "fixture", input: {}, isElicitation: true, elicitationForm: form });
  const failed = render(request, () => { throw Error("disconnected"); });
  await failed.props.decide("deny", undefined, { formResult: { action: "decline" }, onAnswered: (ok) => answered.push(ok) });
  assert.equal(answered.at(-1), false);
  assert.match(derive("cc32965c2-BNok1Xiq.js", read("cc32965c2-BNok1Xiq.js")), /nc as claudexElicitationForm, ic as claudexElicitationLink/);
});
