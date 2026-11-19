import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createRequire } from 'node:module';
// @ts-expect-error Build-time JavaScript entry has no declaration file.
import { buildOfficialUsageActivity } from '../scripts/official-ui-usage-activity-bundle.mjs';
const require=createRequire(import.meta.url);
test('owned Activity bundle uses official settings controls, one React instance and the shared data lifecycle',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-bundle-'));
 try {
  const result=await buildOfficialUsageActivity(dir);
  assert.ok(result.sources.includes('src/settings/usage-activity/use-usage-activity.ts'));
  assert.ok(result.sources.includes('scripts/official-host/usage-activity-view.tsx'));
  assert.equal(result.sources.includes('src/settings/usage-activity/usage-activity.css'),false);
  assert.ok(result.sources.includes('shared/i18n/catalogs/fr-FR.ts'));
  assert.equal(result.sources.some((p:string)=>/node_modules\/react(?:-dom)?\//.test(p)),false);
  const js=result.files.filter((r:any)=>r.file.endsWith('.js')).map((r:any)=>fs.readFileSync(path.join(dir,r.file),'utf8')).join('\n');
  assert.ok(js.includes('vendor-frame-iz8L1jC9.js'));
  assert.ok(js.includes('shared-l-p-m-w-2-BMCa56Vr.js'));
  assert.ok(result.files.some((r:any)=>r.file==='claudex-usage-activity.css'));
  assert.ok(js.includes('shared-1-B16QIYNI.js'));
  assert.ok(js.includes('ce802b15a-CA_45z3b.js'));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('read-only locale following does not overwrite page preference; legacy default still persists',async()=>{
 const bundle=await build({entryPoints:['src/i18n/index.ts'],bundle:true,write:false,format:'cjs',platform:'node',external:['react'],logLevel:'silent'});
 let stored='existing-choice';const document={documentElement:{lang:'existing-page'}};
 const module:any={exports:{}};
 vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,console,document,localStorage:{setItem:(_key:string,value:string)=>stored=value},navigator:{language:'en-US'}});
 await module.exports.setLocale('fr-FR',{persist:false,document:false});
 assert.equal(module.exports.currentLocale(),'fr-FR');
 assert.equal(stored,'existing-choice');assert.equal(document.documentElement.lang,'existing-page');
 await module.exports.setLocale('en-US');
 assert.equal(stored,'en-US');assert.equal(document.documentElement.lang,'en-US');
});
