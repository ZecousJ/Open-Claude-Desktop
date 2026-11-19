import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  deriveOfficialUiHostListUpdatesModule,
  projectInstructionsDraftHook,
  projectInstructionsTarget,
} from "../scripts/official-ui-host-list-updates.mjs";

test("the pinned project editor connects both retained and visible instruction drafts", () => {
  const assets = path.resolve(process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted", "claude-frontend-4.4212.0/src/cloud/assets/v1");
  const source = fs.readFileSync(path.join(assets, projectInstructionsTarget), "utf8");
  const derived = deriveOfficialUiHostListUpdatesModule(projectInstructionsTarget, source);
  assert.ok(derived.includes("[C, w] = claudexUseProjectInstructions(f.prompt_template, T, protectedDraft)"));
  assert.ok(derived.includes("[y, b] = claudexUseProjectInstructions(t)"));
  assert.ok(derived.includes("(w(T.current), l());"));
  assert.ok(derived.includes("await R({ prompt_template: e });"));
});

test("saved instructions refresh pristine editors while retaining open and cancelled drafts", async t => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const useInstructions = vm.runInNewContext(`${projectInstructionsDraftHook}\nclaudexUseProjectInstructions`, {
    n: React.useState, r: React.useRef, c: React.useEffect,
  });
  const root = createRoot(document.getElementById("root"));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, previous); });
  let edit, close, protect;
  function Editor({ initial, onChange }) {
    const [draft, setDraft] = useInstructions(initial);
    edit = value => { setDraft(value); onChange(value); };
    return React.createElement("output", null, draft);
  }
  function Project({ saved, open }) {
    const live = React.useRef(saved);
    const protectedDraft = React.useRef();
    const [draft, setDraft] = useInstructions(saved, live, protectedDraft);
    protect = value => { protectedDraft.current = value; };
    close = () => setDraft(live.current);
    return open ? React.createElement(Editor, { initial: draft, onChange: value => { live.current = value; } }) : null;
  }
  const render = async (saved, open = true) => act(async () => root.render(React.createElement(Project, { saved, open })));
  const value = () => document.querySelector("output")?.textContent;
  await render("A");
  await render("B");
  assert.equal(value(), "B");
  await act(async () => edit("UNSAVED"));
  await render("C");
  assert.equal(value(), "UNSAVED");
  await act(async () => close());
  await render("C", false);
  await render("D", false);
  await render("D");
  assert.equal(value(), "UNSAVED");
  await render("UNSAVED");
  await render("");
  assert.equal(value(), "");
  await render("E", false);
  await render("E");
  assert.equal(value(), "E");

  await act(async () => edit("Retry draft"));
  protect(true);
  await render("Retry draft");
  await render("E");
  protect("Retry draft");
  assert.equal(value(), "Retry draft");
  await act(async () => close());
  await render("E", false);
  await render("E");
  assert.equal(value(), "Retry draft");
  protect(undefined);
  await render("Retry draft");
  await render("F");
  assert.equal(value(), "F");

});
