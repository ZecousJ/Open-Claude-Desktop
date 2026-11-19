/** Pure source/actual GET mapping; inert status snapshots only. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
import {memorySettings,memoryRoute} from '../electron/official-ui/api/memory';
import {organizationUuid} from '../electron/official-ui/api/context';
import {brandedModule} from '../scripts/official-web-assets.mjs';
// @ts-expect-error Build-time JavaScript helper.
import {deriveOfficialUiHostMemoryStatusModule,hostMemoryStatusRules} from '../scripts/official-ui-host-memory-status.mjs';
const source=fs.readFileSync('scripts/official-host/memory-status.mjs','utf8');
const status:any={available:false,reason:'server',allowed:{generate:false,searchChats:false},prefs:{generate:true,searchChats:true},synthesizing:false,global:{content:'Previously recorded inert note',updatedAt:1000,edits:[{text:'Inert manual note'}]}};
function helper(data:any,isError=false,locale='en-US'){
 const jsx=(tag:any,props:any)=>({tag,props});return new Function('jsx','jsxs','useIntl','useReadQuery','memorySettingsKey','useState','useRef','useEffect','useAccount','useToast',source.replace(/^import .*?;$/gm,'').replace(/export /g,'')+';return {memoryFacts,memoryActionState,HostMemorySwitch,HostMemoryMode,HostMemoryStatus,withMemoryStatus,formatMemoryTimestamp};')(jsx,jsx,()=>({locale,formatMessage:({defaultMessage}:any)=>defaultMessage}),()=>({data,isError}),'memory_settings',()=>['idle',()=>{}],(x:any)=>({current:x}),()=>{},()=>({account:{uuid:'owner'},activeOrganization:{uuid:'org'}}),()=>({addError:()=>{}}));
}
test('snapshot facts preserve saved preferences separately from effective unavailable state and real last-known content',()=>{
 const data=memorySettings(status),m=data.claudex_memory;
 assert.equal(data.enabled_saffron,false);assert.equal(m.preferences.generate,true);assert.equal(m.allowed.generate,false);assert.equal(m.snapshot.state,'present');
 const text=JSON.stringify(helper(data).HostMemoryStatus());assert.match(text,/Last-known/);assert.match(text,/Previously recorded/);assert.match(text,/Inert manual note/);
 const unknown=memorySettings({...status,global:undefined});assert.equal(unknown.claudex_memory.snapshot.state,'not_provided');assert.match(JSON.stringify(helper(unknown).HostMemoryStatus()),/does not establish/);
 for(const global of [null,{...status.global,updatedAt:NaN},{...status.global,content:4}])assert.throws(()=>memorySettings({...status,global}));
 assert.throws(()=>memorySettings({...status,reason:'invented'}));
});
test('actual switches fail closed on unknown/read-only/unavailable but retain known existing native search policy',()=>{
 const enabled={...status,available:true,reason:undefined,allowed:{generate:true,searchChats:true}},native=memorySettings(enabled,'native');
 const h=helper(native);assert.equal(h.memoryActionState(native,'search').disabled,false);assert.equal(h.memoryActionState(native,'generate').disabled,true);
 for(const data of [undefined,{},memorySettings(enabled),memorySettings(status,'native')])assert.equal(helper(data).memoryActionState(data,'search').disabled,true);
 const control=h.HostMemorySwitch({control:'switch',kind:'search',disabled:true,checked:true,onCheckedChange:()=>{throw Error('must not execute')}});assert.equal(control.props.disabled,true);
 assert.equal(helper(native,true).HostMemorySwitch({control:'switch',kind:'search'}).props.disabled,true);
 assert.match(JSON.stringify(helper(native,true).HostMemoryStatus()),/Last-known/);
 assert.match(JSON.stringify(helper(memorySettings(status),false,'zh-CN').HostMemoryStatus()),/最后已知/);
});
test('the original mode menu limits choices to the host capability', () => {
 const source=memorySettings({...status,available:true,reason:undefined,allowed:{generate:true,searchChats:true}});
 const values:string[]=[];
 const items=['saffron','melange','off'].map(value=>({value,label:value}));
 const render=(data:unknown,value:string)=>helper(data).HostMemoryMode({
  control:'combobox',value,items,onChange:(choice:string)=>values.push(choice),
 });
 const paused=render(source,'off');
 assert.equal(paused.props.disabled,true);
 paused.props.onChange('saffron');
 assert.deepEqual(values,[]);
 const available={...source,claudex_memory:{...source.claudex_memory,generation_action:'available'}};
 const enabled=render(available,'off');
 assert.equal(enabled.props.disabled,false);
 assert.deepEqual(enabled.props.items.map((item:{disabled:boolean})=>item.disabled),[false,false,false]);
 enabled.props.onChange('saffron');
 assert.deepEqual(values,['saffron']);
});
test('actual GET uses only snapshot status, scopes owner and rejects late activation',async()=>{
 let identity=1,calls:any[]=[],retire=false;
 const ctx:any={readOnly:true,account:()=>({id:'owner'}),sessionIdentity:()=>identity,isCurrent:()=>true,call:async(...args:any[])=>{calls.push(args);if(retire)identity++;return status;}};
 const url=new URL('http://inert.invalid/api/organizations/'+organizationUuid('owner')+'/memory/settings');
 async function read(pathname=url.pathname){let code=0,body:any;const res:any={writeHead:(n:number)=>{code=n},end:(x:string)=>{body=JSON.parse(x)}};await memoryRoute({method:'GET'} as any,res,pathname,new URL(pathname,url),ctx);return{code,body};}
 const response=await read();assert.equal(response.code,200);assert.equal(response.body.claudex_memory.snapshot.memory,status.global.content);assert.deepEqual(calls,[['memoryStatus',{snapshotOnly:true}]]);
 assert.equal((await read(url.pathname.replace(organizationUuid('owner'),organizationUuid('foreign')))).code,404);assert.equal(calls.length,1);
 retire=true;assert.equal((await read()).code,409);
});
test('exact pinned switch guards remain while original page exports have no added memory status card',()=>{
 const name='c6bba3086-CUv0XRS9.js',original=fs.readFileSync((process.env.CLAUDEX_OFFICIAL_EXTRACTED??'.restore/archive-extracted')+'/claude-frontend-4.4212.0/src/cloud/assets/v1/'+name,'utf8'),input=brandedModule(original),output=deriveOfficialUiHostMemoryStatusModule(name,input);
 for(const rule of hostMemoryStatusRules)assert.equal(input.split(rule.before).length,2);
 const originalExports='export { en as a, Ft as c, En as i, It as l, Kn as n, Zt as o, Jn as r, Lt as s, Zn as t, Xt as u };';
 assert.ok(input.includes(originalExports));assert.ok(output.includes(originalExports));
 assert.doesNotMatch(output,/__claudexMemoryStatus|__claudexMemoryKn|__claudexMemoryZn|withMemoryStatus/);
 assert.deepEqual(hostMemoryStatusRules.map((rule:any)=>rule.name),['generation-mode-host-status','generation-switch-host-status','classic-generation-switch-host-status','search-switch-host-status']);
 assert.equal(output.split('l(__claudexMemorySwitch,').length,4);
 // Apart from the original switch guards and their import, every input byte is preserved.
 let restored=output.replace('import {HostMemorySwitch as __claudexMemorySwitch,HostMemoryMode as __claudexMemoryMode} from "./claudex-host-memory-status.js";\n','');
 for(const rule of hostMemoryStatusRules)restored=restored.replace(rule.after,rule.before);
 assert.equal(restored,input);
 assert.deepEqual((ts.createSourceFile('memory.js',output,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS) as any).parseDiagnostics,[]);
 assert.throws(()=>deriveOfficialUiHostMemoryStatusModule(name,input+' '),/checksum/);assert.throws(()=>deriveOfficialUiHostMemoryStatusModule(name,output),/checksum/);
 assert.equal(fs.readFileSync((process.env.CLAUDEX_OFFICIAL_EXTRACTED??'.restore/archive-extracted')+'/claude-frontend-4.4212.0/src/cloud/assets/v1/'+name,'utf8'),original);
});

test('every host helper named import exists in the actual immutable vendor/module exports',()=>{
 const parsed=ts.createSourceFile('helper.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 for(const node of parsed.statements){
  if(!ts.isImportDeclaration(node)||!ts.isStringLiteral(node.moduleSpecifier))continue;
  const file=node.moduleSpecifier.text.replace(/^\.\//,'');
  const target=ts.createSourceFile(file,fs.readFileSync((process.env.CLAUDEX_OFFICIAL_EXTRACTED??'.restore/archive-extracted')+'/claude-frontend-4.4212.0/src/cloud/assets/v1/'+file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const names=new Set<string>();for(const declaration of target.statements){if(ts.isExportDeclaration(declaration)&&declaration.exportClause&&ts.isNamedExports(declaration.exportClause))for(const binding of declaration.exportClause.elements)names.add(binding.name.text);}
  const imports=node.importClause?.namedBindings;if(imports&&ts.isNamedImports(imports))for(const imported of imports.elements){const name=imported.propertyName?.text??imported.name.text;assert.ok(names.has(name),`${file} does not export ${name}`);}
 }
});

test('host notes constrain nowrap parents and preserve long snapshot text with bounded scrolling and localized timestamps',()=>{
 const text='x'.repeat(4096),data=memorySettings({...status,global:{...status.global,content:text,edits:[{text}]}});
 const h=helper(data),control=h.HostMemorySwitch({control:'switch',kind:'generate',checked:false});
 assert.equal(control.tag,'switch');assert.equal(control.props.disabled,true);
 const tree=h.HostMemoryStatus(),nodes:any[]=[];
 const walk=(n:any)=>{if(!n||typeof n!=='object')return;nodes.push(n);const children=n.props?.children;for(const c of Array.isArray(children)?children:[children])walk(c)};
 walk(tree);const pre=nodes.find(n=>n.tag==='pre'),time=nodes.find(n=>n.tag==='time'),list=nodes.find(n=>n.tag==='ul');
 assert.equal(pre.props.children,text);assert.equal(pre.props.style.maxHeight,'20rem');assert.equal(pre.props.style.overflow,'auto');assert.equal(pre.props.style.overflowWrap,'anywhere');assert.equal(list.props.style.maxHeight,'12rem');
 assert.equal(time.props.dateTime,new Date(1000).toISOString());assert.notEqual(time.props.children,time.props.dateTime);
 assert.match(h.formatMemoryTimestamp('2026-11-02T16:00:00Z','en-US'),/2026/);assert.match(h.formatMemoryTimestamp('2026-11-02T16:00:00Z','zh-CN'),/2026/);
 assert.notEqual(h.formatMemoryTimestamp('2026-11-02T16:00:00Z','en-US'),h.formatMemoryTimestamp('2026-11-02T16:00:00Z','zh-CN'));
 assert.equal(h.formatMemoryTimestamp('bad','zh-CN'),'—');assert.doesNotThrow(()=>h.formatMemoryTimestamp('2026-11-02T16:00:00Z','not_a_locale'));
});
