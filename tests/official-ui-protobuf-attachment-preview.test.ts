/** Actual immutable producer/consumer extraction; synthetic data only, no service calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {create,fromBinary,toBinary} from '@bufbuild/protobuf';
import {fileDisplayName} from '../electron/official-ui/api/files';
import {loadRegistry} from '../electron/official-ui/api/timeline';
const root='.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/';
function fn(file:string,name:string,globals:any){
 const src=fs.readFileSync(file,'utf8');const ast=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,file.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
 const def=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(def,name);
 const code=ts.transpileModule('const selected = '+def.getText(ast)+'; selected;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 return vm.runInNewContext(code,globals);
}
test('actual PB attachment schema and pinned card resolver preserve files-api without REST projection',()=>{
 const make=fn('electron/official-ui/api/timeline.ts','attachmentOf',{fileDisplayName,learnAttachment:(a:any)=>({...a,mediaType:'text/plain',kind:'blob'}),FILE_KIND_IMAGE:1,FILE_KIND_BLOB:2,FILE_KIND_DOCUMENT:3});
 const input=make({id:'synthetic-file',name:'inert.txt.extracted.txt',size:12,kind:'text'},'synthetic-org','synthetic-conversation');
 const registry=loadRegistry('build/official-ui/data/conversation-protocol.json');
 const schema=registry.getMessage('anthropic.bard.api.v1alpha.Attachment');assert.ok(schema);
 const decoded:any=fromBinary(schema,toBinary(schema,create(schema,input)));
 assert.equal(decoded.path,'');assert.equal(decoded.downloadUrl,'/api/synthetic-org/files/synthetic-file/contents');
 const project=fn(root+'30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js','vb',{xb:()=>false,wb:()=>false,bu:{IMAGE:1,DOCUMENT:3},se:{Blob:'blob'},Wa:()=>false,Tb:()=>true});
 const card=project(decoded);assert.equal(card.download_source,'files-api');assert.equal(card.serverFileUuid,'synthetic-file');assert.equal(card.text_extracted,true);assert.equal(card.path,undefined);
 const url=fn(root+'shared-m-w-0-Dp3k4Hda.js','r$',{encodeURIComponent});
 const hooks:any={J9:()=>[],Tm:()=> 'synthetic-conversation',ys:()=>({activeOrganization:{uuid:'synthetic-org'}}),aX:()=>false,r$:url,kC:()=>{throw Error('must not select wiggle');}};
 for(let n=0;n<=5;n++){hooks['J'+n]=()=>true;hooks['K'+n]=(...args:any[])=>args.at(-1);}
 const resolve=fn(root+'shared-5-DQLFfFYX.js','ZZ',hooks);
 const chosen=resolve({fileUuid:card.file_uuid,downloadSource:card.download_source,wigglePath:card.path});
 assert.equal(chosen.url,'/api/organizations/synthetic-org/files/synthetic-file/contents');assert.equal(chosen.isExplicitFilesApi,true);
});
