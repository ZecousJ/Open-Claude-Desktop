import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {brandedModule} from '../../scripts/official-web-assets.mjs';
import {deriveOfficialUiHostStaticPreviewModule,staticDrawerSelectionSource,hostStaticPreviewOriginalHashes,hostStaticPreviewInputHashes,hostStaticPreviewRules} from '../../scripts/official-ui-host-static-preview.mjs';
const staticDrawerSelection=new Function('return ('+staticDrawerSelectionSource+')')();
const name='cbaae0d6d-JY6h84ty.js';
const assets=path.join(process.env.CLAUDEX_OFFICIAL_UI_SOURCE??'.restore/archive-extracted/claude-frontend-4.4212.0','src/cloud/assets/v1');
const raw=fs.readFileSync(path.join(assets,name),'utf8');
const branded=brandedModule(raw),out=deriveOfficialUiHostStaticPreviewModule(name,branded);
const org='11111111-1111-4111-8111-111111111111',conversation='22222222-2222-4222-8222-222222222222',artifact='33333333-3333-4333-8333-333333333333',version='44444444-4444-4444-8444-444444444444',later='55555555-5555-4555-8555-555555555555';
const row={uuid:version,artifact_uuid:artifact,conversation_uuid:conversation,artifact_type:'text/html',result_state:'NEVER SENT'};
const props={organizationId:org,conversationId:conversation,versionId:version,rows:[row,{...row,uuid:later}],shared:false,temporary:false};
test('pinned actual drawer transforms post-branding only and preserves original memo renderer',()=>{
 const hash=s=>createHash('sha256').update(s).digest('hex');assert.equal(hash(raw),hostStaticPreviewOriginalHashes[name]);assert.equal(hash(branded),hostStaticPreviewInputHashes[name]);
 assert.throws(()=>deriveOfficialUiHostStaticPreviewModule(name,raw),/checksum/);assert.throws(()=>deriveOfficialUiHostStaticPreviewModule(name,out),/checksum/);
 assert.doesNotMatch(out,/__claudexDrawerSelection|__claudexDrawerStaticPreview|__claudexWithStaticPreview|claudex-host-static-preview/);
 assert.ok(out.includes('K4($, 401, ga, _a, va, ya, c(l, { children: [ga, _a, va, ya] }))'));
 const checked=spawnSync(process.execPath,['--check','--input-type=module'],{input:out,encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
});
test('exact selected version maps owned IDs/type only, never latest or body',()=>{
 assert.deepEqual(staticDrawerSelection(props),{organizationId:org,conversationId:conversation,artifactId:artifact,versionId:version,type:'text/html'});
 assert.equal(staticDrawerSelection({...props,versionId:later}).versionId,later);
 assert.equal(staticDrawerSelection({...props,versionId:'66666666-6666-4666-8666-666666666666'}),null);
 for(const changes of [{shared:true},{temporary:true},{organizationId:undefined},{rows:[]},{rows:[row,row]},{rows:[{...row,conversation_uuid:org}]},{rows:[{...row,artifact_uuid:'identifier-not-uuid'}]}])assert.equal(staticDrawerSelection({...props,...changes}),null);
 assert.equal(staticDrawerSelection({...props,rows:[{...row,artifact_type:'application/vnd.ant.code'}]}).type,'application/vnd.ant.code','unsupported types reach existing explicit disabled control, not execution');
});
test('actual drawer retains the original rendering outside the host integration anchors',()=>{
 const originalDrawer=branded.slice(branded.indexOf('function lr(e) {'),branded.indexOf('function ur(e) {'));
 const currentDrawer=out.slice(out.indexOf('function lr(e) {'),out.indexOf('function ur(e) {'));
 const originalWithReview=hostStaticPreviewRules.filter(rule=>originalDrawer.includes(rule.before))
  .reduce((source,rule)=>source.replace(rule.before,rule.after),originalDrawer);
 assert.ok(originalDrawer.length>1000);assert.equal(currentDrawer,originalWithReview);
 assert.match(currentDrawer,/claudex_chat_artifact_review === true/);
 assert.match(currentDrawer,/\(Zn = \[r, Ke\]\)/);
 assert.match(out,/__claudexPublishBlocked/);
});

test('the original Chat drawer links only exact saved transcript revisions',()=>{
 const start=out.indexOf('function __claudexLinkChatArtifactVersions(');
 const end=out.indexOf('function ar(e, t) {',start);
 const link=new Function(out.slice(start,end)+'return __claudexLinkChatArtifactVersions;')();
 const chatArtifact={id:'widget',versions:[
  {message:'first',resultState:'Original'},
  {message:'second',resultState:'Updated'},
  {message:'third',resultState:'Other',uuid:later},
 ]};
 const records=[
  {...row,artifact_identifier:'widget',message_uuid:'second',version_number:2,result_state:'Updated',uuid:later},
  {...row,artifact_identifier:'widget',message_uuid:'first',version_number:1,result_state:'  Original'},
 ];
 assert.deepEqual(link(chatArtifact,records).versions.map(v=>[v.uuid,v.version_number]),[[version,1],[later,2],[later,undefined]]);
 for(const fields of [{artifact_identifier:'another'},{message_uuid:'another'},{result_state:'Changed'}])
  assert.equal(link(chatArtifact,[{...records[1],...fields}]).versions[0].uuid,undefined);
 assert.match(out,/ir\(__claudexLinkChatArtifactVersions\(e, t\), n\)/);
});

test('esbuild-bundled derivation emits byte-identical modules without function serialization',async()=>{
 const {build}=await import('esbuild');
 for(const minify of [false,true]){
  const built=await build({entryPoints:['scripts/official-ui-host-static-preview.mjs'],bundle:true,platform:'node',format:'esm',write:false,minify});
  const bundled=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
  assert.equal(bundled.staticDrawerSelectionSource,staticDrawerSelectionSource);
  for(const file of Object.keys(hostStaticPreviewInputHashes)){
   const input=brandedModule(fs.readFileSync(path.join(assets,file),'utf8'));
   assert.equal(bundled.deriveOfficialUiHostStaticPreviewModule(file,input),deriveOfficialUiHostStaticPreviewModule(file,input));
  }
 }
});
