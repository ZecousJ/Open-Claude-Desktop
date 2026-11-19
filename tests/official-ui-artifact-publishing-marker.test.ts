/** Actual bootstrap, inert account/settings only; no publication or account service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountOf,organizationOf} from '../electron/official-ui/api/bootstrap';
test('publishing support marker is truthful, account/org bound and never a vendor entitlement',()=>{
 let account:any={id:'owner-A',email:'a@example.invalid',name:'Inert'},current=true;
 const settings={providers:[],officialUi:{}};const ctx:any={account:()=>account,settings:()=>settings,isCurrent:()=>current};
 const a=accountOf(ctx)!;
 assert.deepEqual(a.claudex_artifact_publishing,{version:1,account_uuid:a.uuid,organization_uuid:organizationOf(ctx)!.uuid,supported:false});
 const before=JSON.stringify(settings);
 a.claudex_artifact_publishing!.supported=true;
 assert.equal(accountOf(ctx)!.claudex_artifact_publishing!.supported,false);
 account={...account,id:'owner-B'};const b=accountOf(ctx)!;
 assert.equal(b.claudex_artifact_publishing!.account_uuid,'owner-B');assert.notEqual(b.claudex_artifact_publishing!.organization_uuid,a.claudex_artifact_publishing!.organization_uuid);
 current=false;assert.equal(accountOf(ctx)!.claudex_artifact_publishing,undefined);
 account=undefined;assert.equal(accountOf(ctx),undefined);
 assert.equal(JSON.stringify(settings),before);
});
test('Markdown artifact review uses the writable Chat host',()=>{
 const ctx:any={account:()=>({id:'owner-A',email:'a@example.invalid',name:'Inert'}),settings:()=>({providers:[],officialUi:{}}),isCurrent:()=>true};
 assert.equal(accountOf(ctx)!.claudex_chat_artifact_review,true);
 ctx.readOnly=true;
 assert.equal(accountOf(ctx)!.claudex_chat_artifact_review,undefined);
 ctx.allowChatArtifactReview=true;
 assert.equal(accountOf(ctx)!.claudex_chat_artifact_review,true);
 ctx.isCurrent=()=>false;
 assert.equal(accountOf(ctx)!.claudex_chat_artifact_review,undefined);
 ctx.allowChatArtifactReview=false;ctx.readOnly=false;ctx.isCurrent=()=>false;
 assert.equal(accountOf(ctx)!.claudex_chat_artifact_review,undefined);
});
