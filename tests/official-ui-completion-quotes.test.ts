/** Pure original-producer/consumer contract; no owner/store/model/network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {fromBinary,toBinary,fromJson} from '@bufbuild/protobuf';
import {loadRegistry,deepCreate} from '../electron/official-ui/api/timeline';
import {normalizeCompletionQuotes} from '../electron/official-ui/api/completion-quotes';
const file='build/official-ui/ui/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js';
const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function fn(name:string){const nodes=ast.statements.filter((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(nodes.length,1);return nodes[0].getText(ast);}
const ctx=vm.createContext({At:(s:string)=>/^[a-f0-9-]{36}$/i.test(s),Yr:(s:string)=>!s.trim(),mr:(a:any)=>a.kind==='excerpt'});
for(const name of ['GO','KO','qO','JO','YO','HO','ek','nk','tk','$O','QO'])vm.runInContext(fn(name),ctx);
const plain=(v:any)=>JSON.parse(JSON.stringify(v));
const excerpt=(text:string,comment?:string,targetMessageId?:string)=>({passage:{case:'excerpt',value:{text,...(targetMessageId?{targetMessageId}:{})}},...(comment===undefined?{}:{comment})});
test('actual HO producer → pure preparation → actual QO history consumer preserves comment/source and typed text',()=>{
  // mr/Yr/At imported predicates are explicit inert dependencies, not network.
  const produced=plain(ctx.HO([{kind:'excerpt',extracted_content:'😀 line\r\n\r\nnext',quote_reply:'Explain 🧠',quote_message_uuid:'msg_source'}],'My question',true));
  assert.equal(produced.quotes.length,1);
  const prepared=normalizeCompletionQuotes({text:produced.text,quotes:produced.quotes});
  const decoded=plain(ctx.QO(prepared.quotes,prepared.text));
  assert.equal(decoded.typedText,'My question');
  assert.deepEqual(decoded.quotes,[{passage:'😀 line\n\nnext',reply:'Explain 🧠',target:'msg_source'}]);
  assert.deepEqual(prepared.unverifiedTargetMessageIds,['msg_source']);assert.equal(prepared.ownershipValidated,false);
  assert.equal(prepared.quotes[0].endIndex,Array.from(prepared.text).length-Array.from('My question').length);
});
test('multiple quotes, absent target, blank comment, CRLF/NUL canonicalization keep original consumer roundtrip',()=>{
  const prepared=normalizeCompletionQuotes({text:'typed\r\ntext',quotes:[excerpt('one\0\r\ntwo','\u0085\u00a0'),excerpt('三😀','why\r\nnow')]});
  const decoded=plain(ctx.QO(prepared.quotes,prepared.text));
  assert.equal(decoded.typedText,'typed\r\ntext');
  assert.deepEqual(decoded.quotes,[{passage:'one\ntwo'},{passage:'三😀',reply:'why\nnow'}]);
  assert.deepEqual(prepared.unverifiedTargetMessageIds,[]);
  assert.equal(prepared.quotes[1].startIndex,prepared.quotes[0].endIndex);
});
test('reject unsupported/malformed rich variants rather than silently flattening',()=>{
  for(const q of [excerpt(''),excerpt(' \r\n'),{passage:{case:'wholeMessage',value:{targetMessageId:'msg_x',preview:'x'}}},{...excerpt('x'),author:'forged'},excerpt('x',undefined,'invalid id:assistant'),excerpt('\ud800')])assert.throws(()=>normalizeCompletionQuotes({text:'',quotes:[q]}));
  assert.throws(()=>normalizeCompletionQuotes({text:'',quotes:[],unknown:true}));
});
test('enforces exact codepoint/count/total byte boundaries and does not mutate input',()=>{
  const input={text:'',quotes:[excerpt('😀'.repeat(10000),'x'.repeat(10000))]};const copy=JSON.stringify(input);
  assert.equal(normalizeCompletionQuotes(input).quotes.length,1);assert.equal(JSON.stringify(input),copy);
  assert.throws(()=>normalizeCompletionQuotes({text:'',quotes:[excerpt('😀'.repeat(10001))]}));
  assert.throws(()=>normalizeCompletionQuotes({text:'',quotes:[excerpt('x','x'.repeat(10001))]}));
  assert.throws(()=>normalizeCompletionQuotes({text:'',quotes:Array(11).fill(excerpt('x'))}));
  assert.throws(()=>normalizeCompletionQuotes({text:'😀'.repeat(300000),quotes:[]}));
  assert.deepEqual(normalizeCompletionQuotes({text:'hello',quotes:[]}),{text:'hello',typedText:'hello',quotes:[],unverifiedTargetMessageIds:[],ownershipValidated:false});
});

test('actual protobuf binary and JSON decode defaults are accepted without treating author metadata as user authority',()=>{
  const registry=loadRegistry('build/official-ui/data/conversation-protocol.json');
  const schema=registry.getMessage('anthropic.bard.api.v1alpha.Quote');assert.ok(schema);
  const value=excerpt('source','comment','msg_owned_pending');
  const binary=fromBinary(schema,toBinary(schema,deepCreate(schema,value)));
  const json=fromJson(schema,{excerpt:{text:'source',target_message_id:'msg_owned_pending'},comment:'comment'});
  for(const decoded of [binary,json]) {
    const prepared=normalizeCompletionQuotes({text:'question',quotes:[decoded]});
    assert.equal(prepared.quotes[0].comment,'comment');assert.equal(prepared.ownershipValidated,false);
  }
  assert.throws(()=>normalizeCompletionQuotes({text:'',quotes:[{...value,author:4}]}));
  assert.throws(()=>normalizeCompletionQuotes({text:'',quotes:[{...value,$typeName:'other.Quote'}]}));
});

test('preserves prefix/suffix and valid presentation author without sending surrounding source text as new content',()=>{
  const q={...excerpt('chosen','explain','msg_x'),author:2,passage:{case:'excerpt',value:{text:'chosen',targetMessageId:'msg_x',prefix:'before',suffix:'after'}}};
  const out=normalizeCompletionQuotes({text:'typed',quotes:[q]});
  assert.equal(out.quotes[0].author,2);assert.equal(out.quotes[0].passage.value.prefix,'before');assert.equal(out.quotes[0].passage.value.suffix,'after');
  assert.equal(out.text.includes('before'),false);assert.equal(out.text.includes('after'),false);
  assert.deepEqual(plain(ctx.QO(out.quotes,out.text)).quotes,[{passage:'chosen',reply:'explain',target:'msg_x',around:{prefix:'before',suffix:'after'}}]);
  assert.equal(out.ownershipValidated,false);
  assert.throws(()=>normalizeCompletionQuotes({text:'already combined',quotes:[{...q,startIndex:0,endIndex:4}]}),'history ranges must not be blindly re-appended as fresh send quotes');
});
