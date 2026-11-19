import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { actOnCodeModelProposal, recordCodeModelProposal, waitForModelOffer } from "../../electron/engine/code-model-proposals";
import type { AppContext } from "../../electron/app/app-context";
import type { Conversation } from "../../shared/types";

test("a cloud offer binds the user's choice and dispatches one immutable brief", async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-cloud-offer-"));
 try {
  execFileSync("git", ["-C", root, "init", "-q", "--template="]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/fixture/repository.git"]);
  const store = new Store(root), provider=store.settings.providers[0], now=Date.now();
  provider.model="fixture-model";
  const parent: Conversation={id:randomUUID(),mode:"code",title:"parent",cwd:root,providerId:provider.id,model:provider.model,threadId:"thread",createdAt:now,updatedAt:now,archived:false,pinned:false,turns:[{id:"turn",status:"inProgress",createdAt:now,prompt:"task",attachments:[],items:[]}]};
  store.conversations.push(parent);
  const calls: any[]=[];
  const ctx={store,activeAccount:{id:"owner"},accountActivationIdentity:1,allowedFolder(){},engine:{changed(){},requestAppApproval(){throw Error("unexpected second approval");}},officialCodeHelperCloud:()=>({available:()=>true,listCloudEnvironments:async()=>[{id:"default",name:"Default",network:"trusted",allowedDomains:[],includeDefaultDomains:true,variables:"",setupScript:"",updatedAt:0}],startSideSession:async(input:any)=>{calls.push(input);return "session_0123456789abcdef0123456789abcdef";}})} as unknown as AppContext;
  const proposal=recordCodeModelProposal(ctx,{parent,current:()=>true},{kind:"offer",title:"Task",brief:"",context:"fresh",sourceTurnId:"turn",sourceToolCallId:"tool",sourceCwd:root,providerId:provider.id});
  const waiter=waitForModelOffer(store,parent.id,proposal.id,new AbortController().signal);
  assert.equal(await actOnCodeModelProposal(ctx,parent.id,proposal.id,{kind:"acceptOffer",selection:{target:"cloud",environmentId:"default"}},()=>true),true);
  assert.equal(await waiter,true);
  assert.equal(store.conversations.length,1);
  const fill={kind:"fill" as const,prompt:"Perform work",background:"Background of this work"};
  assert.deepEqual(await actOnCodeModelProposal(ctx,parent.id,proposal.id,fill,()=>true),{taskId:proposal.id});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);
  assert.equal(calls[0].taskId,proposal.id);
  assert.match(calls[0].text,/Perform work/);
  assert.equal(parent.cloudSpawnedTasks?.[0].sessionId,"session_0123456789abcdef0123456789abcdef");
  assert.deepEqual(await actOnCodeModelProposal(ctx,parent.id,proposal.id,fill,()=>true),{taskId:proposal.id});
  assert.equal(calls.length,1);
  await assert.rejects(actOnCodeModelProposal(ctx,parent.id,proposal.id,{...fill,prompt:"Different"},()=>true),/different brief/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
