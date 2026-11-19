import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bootstrapOf } from "../electron/official-ui/api/bootstrap";
import type { AdapterContext } from "../electron/official-ui/api/context";

test("the original rich quote control follows the active host's action capability", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rich-quote-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = {
    root,
    account: () => ({ id: "owner", name: "Owner" }),
    settings: () => ({ providers: [] }),
    modelCatalog: async () => null,
    call: async () => undefined,
    log: () => {},
    isCurrent: () => true,
  } as unknown as AdapterContext;
  const gate = async (patch: Partial<AdapterContext>) => {
    const state = await bootstrapOf({ ...base, ...patch });
    return {
      enabled: state.org_growthbook.features["638990223"].defaultValue,
      visible: state.gated_messages.gates.includes("__gb__638990223"),
      labels: state.gated_messages.messages,
    };
  };
  for (const patch of [
    { readOnly: true },
    { readOnly: true, richQuoteActions: false },
    { account: () => undefined },
    { isCurrent: () => false },
  ]) {
    const state = await gate(patch);
    assert.equal(state.enabled, false);
    assert.equal(state.visible, false);
  }
  for (const patch of [{}, { readOnly: true, richQuoteActions: true }]) {
    const state = await gate(patch);
    assert.equal(state.enabled, true);
    assert.equal(state.visible, true);
    assert.equal(state.labels["secret:1x91a6d"], "Write a reply");
    assert.equal(state.labels["secret:7bcw8c"], "Add");
  }
  const french = await bootstrapOf({
    ...base,
    root: path.resolve("build/official-ui"),
    settings: () => ({ providers: [], locale: "fr-FR" }) as any,
  });
  assert.equal(french.gated_messages.messages["secret:1x91a6d"], "Rédiger une réponse");
  assert.equal(french.gated_messages.messages["secret:ebcglr"], "Annuler");
});

test("the original side chat is offered only with an active side-question gateway",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"side-question-bootstrap-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const base={root,account:()=>({id:"owner",name:"Owner"}),settings:()=>({providers:[]}),modelCatalog:async()=>null,call:async()=>undefined,log:()=>{},isCurrent:()=>true} as unknown as AdapterContext;
  for(const [patch,expected] of [[{},false],[{sideQuestionGateway:async()=>({})},true],[{sideQuestionGateway:async()=>({}),isCurrent:()=>false},false],[{sideQuestionGateway:async()=>({}),account:()=>undefined},false]] as const){
    const state=await bootstrapOf({...base,...patch} as AdapterContext);
    assert.equal(state.org_growthbook.features["3717420587"].defaultValue,expected);
    assert.equal(state.gated_messages.gates.includes("__gb__3717420587"),expected);
  }
});
