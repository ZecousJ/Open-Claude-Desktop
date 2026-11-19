/** Original error component backed by scoped project retry operations. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
import {brandedModule} from '../scripts/official-web-assets.mjs';
// @ts-expect-error Build-time pinned JavaScript helper has no declaration file.
import {deriveOfficialUiHostProjectKnowledgeModule,hostProjectKnowledgeRules} from '../scripts/official-ui-host-project-knowledge.mjs';
const source=fs.readFileSync('scripts/official-host/project-knowledge-error.mjs','utf8');
const props={projectUuid:'project',organizationUuid:'org',accountUuid:'owner'};
function fixture({errors=[true,false,false],locale='en-US',wait=Promise.resolve(),reject=false,earlyReject=false}:{errors?:boolean[],locale?:string,wait?:Promise<unknown>,reject?:boolean,earlyReject?:boolean}={}){
 let state=false,cleanup:undefined|(()=>void);const updates:boolean[]=[],calls:any[]=[];
 const refs=[{current:null},{current:true}];let index=0;
 const query=(kind:string,error:boolean)=>({isError:error,refetch:async(options:unknown)=>{calls.push([kind,options]);if(earlyReject&&kind==='docs')throw Error('inert early failure');await wait;if(reject)throw Error('SECRET upstream failure');return{isError:error}}});
 const hooks:any={useState:()=>[state,(value:boolean)=>{state=value;updates.push(value)}],useRef:()=>refs[index++],useEffect:(effect:()=>()=>void)=>{if(!cleanup)cleanup=effect()},useIntl:()=>({locale,formatMessage:({defaultMessage}:any)=>defaultMessage}),Status:'official-status',useDocs:(_id:string,enabled:boolean)=>{assert.equal(enabled,false);return query('docs',errors[0])},useFiles:(_id:string,enabled:boolean)=>{assert.equal(enabled,false);return query('files',errors[1])},useQueryClient:()=>({refetchQueries:async(...args:any[])=>{calls.push(['syncs',...args]);await wait;if(reject)throw Error('SECRET upstream failure')}}),syncQueryName:'project_sync_list',jsx:(tag:any,props:any,key:any)=>({tag,props,key}),jsxs:(tag:any,props:any)=>({tag,props})};
 const mod=new Function(...Object.keys(hooks),source.replace(/^import .*?;$/gm,'').replace(/export /g,'')+';return{ProjectKnowledgeError,withProjectKnowledgeError};')(...Object.values(hooks));
 return{calls,updates,mod,render:()=>{index=0;return mod.ProjectKnowledgeError({...props,failed:errors.some(Boolean)})},cleanup:()=>cleanup?.()};
}
test('each real query error is visible, with no false empty-list success and normal/loading left unchanged',()=>{
 for(const errors of [[true,false,false],[false,true,false],[false,false,true]])for(const locale of ['en-US','zh-CN']){
  const f=fixture({errors,locale}),tree=f.render();assert.equal(tree.props.variant,'error');
  const text=JSON.stringify(tree);assert.match(text,/Something went wrong/);assert.match(text,/Try again/);
  assert.equal(f.calls.length,0);
 }
 assert.equal(fixture({errors:[false,false,false]}).render(),null);
});
test('retry invokes only the actual two refetch functions and exact scoped sync query, stays bounded while pending',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r),f=fixture({wait}),tree=f.render(),retry=tree.props.onCtaClick;
 const pending=retry();await retry();assert.equal(f.calls.length,3);assert.equal(f.render().props.ctaBusy,true);
 assert.deepEqual(f.calls[2],['syncs',{queryKey:['project_sync_list',{orgUuid:'org',projectUuid:'project',calculateSize:undefined}],exact:true,type:'active'},{cancelRefetch:false,throwOnError:true}]);
 assert.deepEqual(f.calls[0],['docs',{cancelRefetch:false}]);assert.deepEqual(f.calls[1],['files',{cancelRefetch:false}]);
 release();await pending;assert.equal(f.render().props.ctaBusy,false);assert.equal(f.render().props.variant,'error');
});
test('retry errors retain visible fixed warning without raw source errors or fake success',async()=>{
 const f=fixture({reject:true});await f.render().props.onCtaClick();assert.equal(f.render().props.variant,'error');assert.doesNotMatch(JSON.stringify(f.render()),/SECRET|success|complete list loaded/);assert.equal(f.updates.at(-1),false);
});
test('unmount retires pending retry state; no new retry from old handler',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r),f=fixture({wait}),retry=f.render().props.onCtaClick;
 const pending=retry();f.cleanup();const count=f.updates.length;release();await pending;assert.equal(f.updates.length,count);await retry();assert.equal(f.calls.length,3);
});
test('error wrapper preserves existing real entries as explicitly incomplete, keys account/org/project, and normal identity untouched',()=>{
 const f=fixture(),existing={rows:['real']};assert.equal(f.mod.withProjectKnowledgeError(false,0,props,existing),existing);
 const empty=f.mod.withProjectKnowledgeError(true,0,props,existing);assert.equal(empty.props.children[1],null);
 const nonempty=f.mod.withProjectKnowledgeError(true,1,props,existing);assert.equal(nonempty.props.children[1],existing);
 const key=nonempty.props.children[0].key;
 for(const changed of [{...props,projectUuid:'other'},{...props,organizationUuid:'other'},{...props,accountUuid:'other'}])assert.notEqual(f.mod.withProjectKnowledgeError(true,1,changed,existing).props.children[0].key,key);
});
test('pinned project transform is additive and syntax-valid, fails on drift/reapply, preserves original archive',()=>{
 const name='cdeaafbfc-Bs8B_xOb.js',original=fs.readFileSync((process.env.CLAUDEX_OFFICIAL_EXTRACTED??'.restore/archive-extracted')+'/claude-frontend-4.4212.0/src/cloud/assets/v1/'+name,'utf8'),input=brandedModule(original),output=deriveOfficialUiHostProjectKnowledgeModule(name,input);
 assert.ok(output.includes('le = j || L !== 0 || I.knowledgeReadFailed'));
 assert.ok(output.includes('__claudexKnowledgeError(I.knowledgeReadFailed,L,{projectUuid:t.uuid,organizationUuid:K,accountUuid:q}'));
 assert.ok(output.includes('children: [Q, fe]'));
 const parsed=ts.createSourceFile('project.js',output,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS) as any;assert.deepEqual(parsed.parseDiagnostics,[]);
 for(const rule of hostProjectKnowledgeRules.filter((rule: {file:string})=>rule.file===name))assert.equal(input.split(rule.before).length,2);
 assert.throws(()=>deriveOfficialUiHostProjectKnowledgeModule(name,input+' '),/checksum/);assert.throws(()=>deriveOfficialUiHostProjectKnowledgeModule(name,output),/checksum/);
 assert.equal(fs.readFileSync((process.env.CLAUDEX_OFFICIAL_EXTRACTED??'.restore/archive-extracted')+'/claude-frontend-4.4212.0/src/cloud/assets/v1/'+name,'utf8'),original);
});

test('original project form assigns one creation identity in its initial state',()=>{
 const name='c4a0274e5-Q8MvhwLz.js';
 const raw=fs.readFileSync((process.env.CLAUDEX_OFFICIAL_EXTRACTED??'.restore/archive-extracted')+'/claude-frontend-4.4212.0/src/cloud/assets/v1/'+name,'utf8');
 const output=deriveOfficialUiHostProjectKnowledgeModule(name,brandedModule(raw));
 const parsed=ts.createSourceFile('creation.js',output,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS) as any;
 assert.deepEqual(parsed.parseDiagnostics,[]);
 const initializer=output.slice(output.indexOf('function Oe(t)'),output.indexOf('[G, ve] = e(ge)'));
 assert.equal(initializer.split('client_creation_id: crypto.randomUUID()').length,2);
 assert.ok(output.includes('...G,\n                            type: U ?? G.type'));
});

test('one early query rejection cannot release busy while the other reads remain pending',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r),f=fixture({wait,earlyReject:true}),retry=f.render().props.onCtaClick;
 const pending=retry();await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,3);assert.equal(f.render().props.ctaBusy,true);
 await retry();assert.equal(f.calls.length,3);release();await pending;assert.equal(f.render().props.ctaBusy,false);assert.equal(f.render().props.variant,'error');
});

test('error panel does not mount enabled duplicate query observers or auto-retry on a source error',()=>{
 // Hooks assert their real enabled argument is false. Repeated mounts cannot
 // call refetch; only the explicit click starts the controlled batch.
 for(let mount=0;mount<5;mount++){const f=fixture();assert.equal(f.render().props.variant,'error');assert.deepEqual(f.calls,[]);f.cleanup();}
 assert.equal(source.includes('useSyncs'),false);
 const f=fixture();assert.equal(f.mod.withProjectKnowledgeError(true,0,props,null).props.children[0].props.failed,true);
});
