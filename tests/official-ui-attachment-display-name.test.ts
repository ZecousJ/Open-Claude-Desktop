/** Display-only regression: actual REST and PB projections, isolated account scopes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationUpdate} from '../electron/official-ui/api/timeline';
import {learnAttachment,rememberInlineDisplay,uploadAnswer,fileDisplayName} from '../electron/official-ui/api/files';
import {inAdapterScope,newAdapterScope} from '../electron/official-ui/api/scope';

function project(a:any){return conversationUpdate({id:'conversation',createdAt:1,updatedAt:1,turns:[{id:'turn',createdAt:1,status:'completed',prompt:'explain',items:[],attachments:[a]}]} as any,false,{org:'org'}).messages![0].attachments[0];}
test('ordinary excerpt uses original display name in REST and actual timeline without changing storage identity',()=>{
 const a={id:'excerpt',name:'excerpt_from_previous_claude_message.txt.extracted.txt',size:3,kind:'text',path:'/untrusted/transcript/path'};
 inAdapterScope(newAdapterScope('owner-a'),()=>{
  const file=learnAttachment(a as any,'conversation');const original={id:file.id,name:file.name,path:file.path,size:file.size};
  rememberInlineDisplay(file,{file_name:'excerpt_from_previous_claude_message.txt',file_type:'txt',kind:'excerpt'},'abc');
  const pb=project(a),rest=uploadAnswer('org',file);
  assert.equal(pb.fileName,'excerpt_from_previous_claude_message.txt');assert.equal(rest.file_name,pb.fileName);
  assert.equal(pb.id,a.id);assert.equal(pb.downloadUrl,'/api/org/files/excerpt/contents');assert.equal(pb.fileSize,3n);
  assert.deepEqual({id:file.id,name:file.name,path:file.path,size:file.size},original);assert.equal(file.path,undefined);
  assert.equal(project(a).fileName,pb.fileName);
 });
 inAdapterScope(newAdapterScope('owner-b'),()=>assert.equal(project(a).fileName,a.name));
});
test('ordinary uploads and legacy derivatives retain real name; invalid display metadata never supplies a path',()=>{
 inAdapterScope(newAdapterScope('owner'),()=>{
  for(const name of ['notes.txt','report.pdf','legacy.txt.extracted.txt']){
   const a={id:name,name,size:3,kind:name.endsWith('.pdf')?'document':'text'};const file=learnAttachment(a as any,'conversation');
   assert.equal(project(a).fileName,name);assert.equal(uploadAnswer('org',file).file_name,name);
   for(const bad of ['', '../other.txt','x'.repeat(501)]){(file as any).inlineDisplay={file_name:bad};assert.equal(fileDisplayName(file),name);assert.equal(project(a).fileName,name);}
  }
 });
});
