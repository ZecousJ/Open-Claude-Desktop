import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {brandedModule} from '../../scripts/official-web-assets.mjs';
import {deriveOfficialUiHostStaticPreviewModule} from '../../scripts/official-ui-host-static-preview.mjs';
const source=fs.readFileSync('scripts/official-host/artifact-publishing.mjs','utf8');
function fixture(locale='en-US'){return new Function('jsx','jsxs','Fragment','useIntl',source.replace(/^import .*;$/gm,'').replace(/export /g,'')+';return {publishingUnavailable,blockedPublish,PublishingUnavailableNotice};')((tag,props)=>({tag,props}),(tag,props)=>({tag,props}),'fragment',()=>({locale}));}
const context=()=>({account:{uuid:'A',claudex_host_authentication:{version:1,status:'authenticated',account_uuid:'A'},claudex_artifact_publishing:{version:1,account_uuid:'A',organization_uuid:'O',supported:false}},activeOrganization:{uuid:'O'}});
const assets=path.join(process.env.CLAUDEX_OFFICIAL_UI_SOURCE??'.restore/archive-extracted/claude-frontend-4.4212.0','src/cloud/assets/v1');
const name='cbaae0d6d-JY6h84ty.js',out=deriveOfficialUiHostStaticPreviewModule(name,brandedModule(fs.readFileSync(path.join(assets,name),'utf8')));
test('only exact authenticated host account/org unsupported descriptor changes publishing presentation',()=>{
 const f=fixture();assert.equal(f.publishingUnavailable(context()),true);
 for(const edit of [c=>delete c.account.claudex_artifact_publishing,c=>delete c.account.claudex_host_authentication,c=>c.account.uuid='B',c=>c.activeOrganization.uuid='B',c=>c.account.uuid='',c=>c.account.claudex_artifact_publishing.supported=true,c=>c.account.claudex_artifact_publishing.version=2,c=>c.account.claudex_host_authentication.status='signed-out']){const c=context();edit(c);assert.equal(f.publishingUnavailable(c),false);}
 assert.equal(f.publishingUnavailable(undefined),false);
});
test('actual transformed toolbar and menu disabled predicates plus callback refuse host Publish, unmarked preserves action',()=>{
 const f=fixture();let calls=0;const original=()=>calls++;
 const bindings=out.match(/    le = __claudexPublishBlocked[^;]+?    U = Je\(\),/)[0].replace(/,\n    U = Je\(\),$/,';');
 const bind=new Function('__claudexPublishBlocked','__claudexOriginalPublishCheck','__claudexOriginalPublishOpen','__claudexBlockedPublish','let '+bindings.trim()+'return {le,fe};');
 const predicates=[...out.matchAll(/disabled: (R \|\| I \|\| Ae \|\| le !== "ok"|I \|\| Ae \|\| le !== "ok" \|\| F),/g)].map(m=>m[1]);assert.equal(predicates.length,2);
 for(const blocked of [true,false]){const {le,fe}=bind(blocked,'ok',original,f.blockedPublish);for(const expression of predicates)assert.equal(new Function('le','R','I','Ae','F','return '+expression)(le,false,false,false,false),blocked);fe();}
 assert.equal(calls,1);
 assert.match(out,/J5\(\$, 89, G, fe, U, Ae, I, et, le, L, B, F, R\)/);
 assert.match(out,/J5\(\$, 192, fe, Ae, I, et, le, L, B, F, R\)/);
 assert.match(out,/return g\(__claudexPublishingNotice,\{blocked:__claudexPublishBlocked,children:\(J2\(\$, 326/);
 assert.ok(out.includes('defaultMessage: "Copy"'));
});
test('the original toolbar remains unchanged when publication is unavailable',()=>{
 for(const locale of ['en-US','zh-CN']){const f=fixture(locale),original={toolbar:'original'};assert.equal(f.PublishingUnavailableNotice({blocked:false,children:original}),original);assert.equal(f.PublishingUnavailableNotice({blocked:true,children:original}),original);}
});
