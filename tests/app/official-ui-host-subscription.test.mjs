import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {brandedModule} from '../../scripts/official-web-assets.mjs';
import {noVendorSubscriptionSource,subscriptionRouteSource,hostModelSubscriptionSource,hostSubscriptionRules,hostSubscriptionInputHashes,deriveOfficialUiHostSubscriptionModule as derive,applyOfficialUiHostSubscription as apply} from '../../scripts/official-ui-host-subscription.mjs';
const root='.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1';
const sources=Object.fromEntries(Object.keys(hostSubscriptionInputHashes).map(file=>[file,brandedModule(fs.readFileSync(path.join(root,file),'utf8'))]));
const account=()=>({uuid:'owner',claudex_host_authentication:{version:1,status:'authenticated',account_uuid:'owner'}});
function box(state){const context={state,ce:()=>({account:context.state}),Q5:'ExistingRouterNavigate',tT:(type,props)=>({type,props})};vm.createContext(context);vm.runInContext(noVendorSubscriptionSource+subscriptionRouteSource+';this.matches=__claudexNoVendorSubscription;this.wrap=__claudexSubscriptionRoute;',context);return context;}
test('existing bound host marker is product identity only; unknown and other accounts retain vendor behavior',()=>{
 const b=box(account());assert.equal(b.matches(b.state),true);
 for(const a of [undefined,{}, {uuid:'owner'}, {...account(),uuid:'other'}, {...account(),uuid:''}, {uuid:'owner',claudex_host_authentication:{version:2,status:'authenticated',account_uuid:'owner'}}, {uuid:'owner',claudex_host_authentication:{version:1,status:'pending',account_uuid:'owner'}}])assert.equal(b.matches(a),false);
 assert.equal(b.state.has_claude_pro,undefined);assert.equal(b.state.capabilities,undefined);
});
test('only vendor subscription route components use existing replacement navigation, no purchase or original component invocation',()=>{
 const b=box(account()),original=()=>{throw Error('must not execute vendor purchase')},props={test:'preserved'};const wrapped=b.wrap(original);
 const redirected=wrapped(props);assert.equal(redirected.type,b.Q5);assert.equal(redirected.props.to,'/new');assert.equal(redirected.props.replace,true);
 b.state=undefined;const normal=wrapped(props);assert.equal(normal.type,original);assert.equal(normal.props,props);
 assert.deepEqual(hostSubscriptionRules.filter(r=>r.name.startsWith('leave-')).map(r=>r.name),['leave-vendor-upgrade-route','leave-vendor-downgrade-route','leave-vendor-pricing-route']);
});
test('exact anchored pill/menu changes keep hook order and cached visibility values reactive',()=>{
 const pill=derive('shared-100-CDJp2jvs.js',sources['shared-100-CDJp2jvs.js']);
 assert.ok(pill.includes('f = Ks(t) && !__claudexNoVendorSubscription(__hostAccount),'));
 assert.ok(pill.includes('g = f && !p && !(u !== void 0 && (h || r))'));
 const menu=derive('shared-19-DSOWNXOA.js',sources['shared-19-DSOWNXOA.js']);assert.ok(menu.includes('j = !_ && !v && !__claudexNoVendorSubscription(u),'));
 for(const state of [account(),undefined]){const b=box(state);vm.runInContext('pill= true && !__claudexNoVendorSubscription(state); menu= !false && !false && !__claudexNoVendorSubscription(state);',b);assert.equal(b.pill,!state);assert.equal(b.menu,!state);}
});
test('Claudex account trigger shows the account name without its routing plan',()=>{
 const file='shared-19-DSOWNXOA.js';
 const rule=hostSubscriptionRules.find(r=>r.name==='hide-host-plan-in-account-trigger');
 assert.ok(derive(file,sources[file]).includes(rule.after));
 const b=box(account());
 Object.assign(b,{i:false,m:'free',a:b.state,o:{plan_display_name:'codex',name:'Organization'},tM:{}});
 const render=()=>vm.runInContext(rule.after.trim().slice(0,-1),b);
 assert.equal(render(),undefined);
 b.m='raven';assert.equal(render(),'Organization');
 b.m='free';b.a=undefined;assert.equal(render(),'codex');
});
test('Billing, top-up, usage and order paths are untouched; no new UI copy or permission fields',()=>{
 const file='shared-46-BL5bnnMV.js',source=sources[file],output=derive(file,source);
 assert.ok(source.includes('path: "settings/billing/$organization_id"'));assert.ok(output.includes('path: "settings/billing/$organization_id"'));
 assert.ok(output.includes('component: yH("OrgBillingLinkRoute")'));
 for(const unrelated of ['shared-20-C2JgSgMH.js','cbbbe68ed-D7XDklrs.js','page-shim.cjs','usage.ts'])assert.equal(derive(unrelated,'unchanged'),'unchanged');
 for(const rule of hostSubscriptionRules)assert.doesNotMatch(rule.after.replace('defaultMessage: "Unsupported model", id: "PCrwsn"',''),/settings\/billing|__claudex\/checkout|payment\/orders|defaultMessage|has_claude_pro|claude_max/);
 for(const [file,source] of Object.entries(sources)){let result=derive(file,source);result=result.slice(noVendorSubscriptionSource.length+(file==='shared-46-BL5bnnMV.js'?subscriptionRouteSource.length:0)+(file==='shared-8-B9DjIUqu.js'?hostModelSubscriptionSource.length:0));for(const rule of hostSubscriptionRules.filter(r=>r.file===file).reverse())result=result.replace(rule.after,rule.before);assert.equal(result,source);}
});
test('hash mismatch or repeated derivation refuses before any source write; original archive immutable',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claudex-subscriptions-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 for(const [file,source] of Object.entries(sources))fs.writeFileSync(path.join(directory,file),source);
 const first=Object.keys(sources)[0],last=Object.keys(sources).at(-1);fs.appendFileSync(path.join(directory,last),'\n');assert.throws(()=>apply(directory),/checksum/);assert.equal(fs.readFileSync(path.join(directory,first),'utf8'),sources[first]);
 fs.writeFileSync(path.join(directory,last),sources[last]);const manifest=apply(directory);assert.equal(manifest.modules.length,4);assert.throws(()=>apply(directory),/checksum/);const archive=path.join(directory,'.restore');fs.mkdirSync(archive);assert.throws(()=>apply(archive),/immutable/);
});
test('assembly and production verifier include matching final derivation and strict revision-set parity',()=>{
 const build=fs.readFileSync('scripts/build-official-ui.mjs','utf8'),verify=fs.readFileSync('scripts/official-web-assets.mjs','utf8');
 assert.ok(build.indexOf('applyOfficialUiHostSubscription(modulesDir)')>build.indexOf('applyOfficialUiHostUsage(modulesDir)'));
 assert.ok(verify.includes('!!meta.hostSubscription !== !!meta.hostAuth'));
 assert.ok(verify.includes('deriveOfficialUiHostSubscriptionModule(name, usageAware)'));
 assert.ok(verify.includes('[meta.hostSubscription, hostSubscriptionInputHashes, hostSubscriptionRules, hostSubscriptionOriginalHashes, null]'));
});

test('host models use only actual selectable catalog entries; missing, disabled and unknown never gain selection',()=>{
 const b=box(account());vm.runInContext(hostModelSubscriptionSource+';this.ids=__claudexHostModelIds;this.presentation=__claudexModelPresentation;',b);
 const entries=[{id:'gpt-6.1-sol'},{id:'unknown',unsupported:true},{id:'blocked',disabled_reason:{type:'org_restricted'}},{id:'off',disabled:true},{id:'seat'},{id:4}];
 const catalog={models:entries,isSelectable:id=>id!=='seat'};
 assert.deepEqual(Array.from(b.ids(b.state,catalog,[])),['gpt-6.1-sol']);
 assert.deepEqual(Array.from(b.ids(b.state,undefined,['invented'])),[]);
 const vendor=['vendor'];assert.equal(b.ids(undefined,catalog,vendor),vendor);
 const entry={id:'blocked',disabled:true,disabled_reason:{type:'upgrade_required'},selection_notice:{text:'Existing explanation',cta:{intent:'upgrade',copy:'Upgrade'}}};
 const out=b.presentation(b.state,entry);assert.equal(out.disabled,true);assert.equal(out.disabled_reason,entry.disabled_reason);assert.equal(out.selection_notice.text,'Existing explanation');assert.equal(out.selection_notice.cta,undefined);assert.ok(entry.selection_notice.cta);
 const explanation=b.presentation(b.state,{...entry,selection_notice:{cta:entry.selection_notice.cta}}, {formatMessage:x=>x.defaultMessage});assert.equal(explanation.selection_notice.text,'Unsupported model');assert.equal(explanation.disabled,true);
 const actual=b.presentation(b.state,{...entry,disabled_reason:{type:'upgrade_required',message:'Actual catalog restriction'},selection_notice:{cta:entry.selection_notice.cta}}, {formatMessage:()=>{throw Error('Actual reason must be retained')}});assert.equal(actual.selection_notice.text,'Actual catalog restriction');
 const credits={...entry,selection_notice:{cta:{intent:'buy_credit',copy:'Buy credits'}}};assert.equal(b.presentation(b.state,credits),credits);assert.equal(b.presentation(undefined,entry),entry);
});
test('host hook keeps unconditional hook order and forwards exact model surface without modifying entitlements',()=>{
 let calls=[];const b=box(account());b.__claudexVendorAvailableModels=()=>{calls.push('vendor');return []};b.E_=()=>{calls.push('account');return {account:b.state}};b.X0=surface=>{calls.push(surface);return {models:[{id:'allowed'}],isSelectable:()=>true}};
 vm.runInContext(hostModelSubscriptionSource+';this.available=XA;',b);
 assert.deepEqual(Array.from(b.available('cowork')),['allowed']);assert.deepEqual(calls,['vendor','account','cowork']);calls=[];b.state=undefined;assert.deepEqual(Array.from(b.available('chat')),[]);assert.deepEqual(calls,['vendor','account','chat']);
});
test('transformed model module parses and preserves every original real disabled/capability guard',async()=>{
 const {transformSync}=await import('esbuild');const file='shared-8-B9DjIUqu.js',out=derive(file,sources[file]);
 transformSync(out,{loader:'js'});
 for(const guard of ['F = !T && (d || f || A || p)','s.disabled_reason?.type !== "desktop_update_required"','s.disabled_reason?.type !== "claude_code_update_required"','!O(r.id, "mm_images")','Q.shouldGate || Q.memberCanRequest'])assert.ok(out.includes(guard));
});
