/** Read-only audit of production code; writes only an isolated synthetic fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {Readable} from 'node:stream';
import {registerCollectionHandlers} from '../electron/ipc/collections';
import {projectsRoute,knowledgeId,projectRow} from '../electron/official-ui/api/projects';
import {organizationUuid} from '../electron/official-ui/api/context';
function original(file:string,name:string){const s=fs.readFileSync('build/official-ui/ui/assets/v1/'+file,'utf8');const a=s.indexOf(`function ${name}(`),b=s.indexOf('\n}',a+1)+2;assert.ok(a>=0&&b>a);return '('+s.slice(a,b)+')';}
test('PDF stays in files partition without poisoning text docs; original byte preview remains exact',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'f025-pdf-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const handlers=new Map<string,any>();
 const store={root,projects:[{id:'p',name:'Synthetic',description:'',instructions:'',createdAt:1}]};
 registerCollectionHandlers((n,f)=>handlers.set(n,f),{store,onSettingsChanged(){},onAccountActivated(){},onAccountDeactivating(){}} as any);
 const ctx:any={account:()=>({id:'synthetic'}),sessionIdentity:()=>1,stateDirectory:()=>root,isCurrent:()=>true,snapshot:async()=>({projects:store.projects}),call:async(n:string,...a:any[])=>handlers.get(n)(...a)};
 const base=`/api/organizations/${organizationUuid('synthetic')}/projects/p/`;
 async function run(rest:string,req:any={method:'GET'}){let status=0,headers:any,body:any;const res:any={writeHead(s:number,h:any){status=s;headers=h;},end(b:any){body=b;}};await projectsRoute(req,res,base+rest,new URL(base+rest,'http://localhost'),ctx);return {status,headers,body};}
 await handlers.get('addProjectKnowledgeText')('p',{name:'Text',text:'Keep visible'});
 // Header-only inert PDF fixture tests transport/classification, not a PDF parser or renderer.
 const pdf=Buffer.from('%PDF-1.4\n% synthetic transport fixture\n%%EOF\n');
 const form=new FormData();form.append('file',new Blob([pdf],{type:'application/pdf'}),'Fixture.PDF');
 const request=new Request('http://localhost',{method:'POST',body:form});
 const req:any=Readable.from([Buffer.from(await request.arrayBuffer())]);req.method='POST';req.headers={'content-type':request.headers.get('content-type')};
 const upload=await run('upload',req);assert.equal(upload.status,200);
 const file=JSON.parse(String(upload.body));assert.equal(file.file_kind,'document');assert.equal(file.file_uuid,knowledgeId('p','Fixture.PDF'));
 assert.equal(file.document_asset.url,base+'knowledge/'+file.file_uuid);
 const raw=await run('knowledge/'+file.file_uuid);assert.equal(raw.status,200);assert.equal(raw.headers['Content-Type'],'application/pdf');assert.deepEqual(raw.body,pdf);
 const docs=await run('docs');assert.equal(docs.status,200);
 assert.deepEqual(JSON.parse(String(docs.body)).map((x:any)=>[x.file_name,x.content]),[['Text.md','Keep visible']]);
 const files=JSON.parse(String((await run('files')).body));assert.equal(files.length,1);assert.equal(files[0].file_uuid,file.file_uuid);assert.equal(files[0].file_kind,'document');
 const inventory=await handlers.get('listProjectKnowledge')('p');
 const row=projectRow(store.projects[0],undefined,inventory);assert.equal(row.docs_count,1);assert.equal(row.files_count,1);
 assert.equal((await run('docs/'+file.file_uuid)).status,404);
 // Uppercase extension is the uploaded fixture; lowercase is classified identically.
 assert.equal(projectRow(store.projects[0],undefined,{...inventory,files:[{name:'lower.pdf',bytes:pdf.length,addedAt:1}]}).files_count,1);
 const deleteDoc:any=Readable.from([]);deleteDoc.method='DELETE';assert.equal((await run('docs/'+file.file_uuid,deleteDoc)).status,204);
 assert.deepEqual((await run('knowledge/'+file.file_uuid)).body,pdf);
 const del:any=Readable.from([JSON.stringify({file_uuids:[file.file_uuid,knowledgeId('p','Text.md')]})]);del.method='POST';
 const deleted=await run('files/delete_many',del);assert.equal(deleted.status,200);assert.deepEqual(JSON.parse(String(deleted.body)),{deleted:[file.file_uuid]});
 assert.equal((await run('knowledge/'+file.file_uuid)).status,404);assert.equal((await run('docs')).status,200);

 const view=vm.runInNewContext(original('shared-m-8-CVxtIISM.js','tG'),{IM:{SanitizedDocument:'document',Blob:'blob'}});
 assert.equal(view(file),true,'eligibility only; not evidence the original modal renders');
 const modal=vm.runInNewContext(original('shared-m-8-CVxtIISM.js','ac'),{
   J9:()=>[],J1:()=>false,J2:()=>false,pQ:()=>({}),YS3:()=>false,rtd:()=>({present:true,open:true}),
 });
 assert.throws(()=>modal({isOpen:true,setIsOpen(){},documentFile:file}),/url/,
   'known remaining original modal requirement: thumbnail_asset is absent; do not fabricate one');
});
