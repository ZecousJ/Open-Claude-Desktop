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

test("browser permission buttons submit the chosen scope without a form submission", (t) => {
  if (!fs.existsSync(root)) return t.skip("Pinned original resources are unavailable");
  const file = "cc32965c2-BNok1Xiq.js";
  const source = derive(file, read(file));
  const start = source.indexOf("  const approval = g.properties?.decision;");
  const end = source.indexOf("  return J3($, 78, s, re, fe)", start);
  assert.ok(start >= 0 && end > start);
  const element = (type, props) => ({ type, ...props });
  const render = vm.runInNewContext(`(g, a, T) => { ${source.slice(start, end)} }`, {
    m: element, i: element, E: "button", mt: "armed", Qo: "card", ns: "summary",
    M: "Script and origin", se: "decline", t: "request", rs: "", s: 1, tc: undefined,
    ce: false, ie: false, c: { locale: "en", formatMessage: ({ defaultMessage }) => defaultMessage },
  });
  for (const choices of [["once"], ["once", "always"]]) {
    const decision = { type: "string", enum: choices, enumNames: ["Allow once", "Always allow for this website"].slice(0, choices.length) };
    const results = [];
    const draw = (fieldNames) => render({ properties: { decision } }, { fieldNames }, result => results.push(JSON.parse(JSON.stringify(result))));
    const [summary, actions] = draw(["decision"]).children;
    assert.equal(summary.children, "Script and origin");
    const [deny, always, armed] = actions.children;
    assert.equal(deny, "decline");
    assert.equal(armed.children.children, "Allow once");
    armed.children.onClick();
    if (choices.length === 2) {
      assert.equal(always.children, "Always allow for this website");
      always.onClick();
    } else assert.equal(always, false);
    assert.deepEqual(results, choices.map(decision => ({ action: "accept", content: { decision } })));
    assert.equal(draw(["decision", "reason"]), undefined);
  }
});
