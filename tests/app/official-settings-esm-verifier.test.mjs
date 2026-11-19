import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {settingsEsmEntries} from "../../scripts/verify-official-settings-esm.mjs";

test("final-assets verifier rejects missing exports, absent dependency, syntax errors and escaped dependency without evaluation", (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"settings-esm-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,"ui/assets/v1");fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(dir,"manifest.json"),'{}');
  const [modal,...deps]=settingsEsmEntries;
  const run=()=>spawnSync(process.execPath,["--experimental-vm-modules","scripts/verify-official-settings-esm.mjs",dir],{encoding:"utf8",timeout:15000});
  const reset=()=>{
    fs.writeFileSync(path.join(root,modal),deps.map((f,i)=>`import {ok as value${i}} from './${f}';`).join('\n')+'\nthrow Error("MUST_NOT_EVALUATE");');
    for(const f of deps)fs.writeFileSync(path.join(root,f),'export const ok=1; throw Error("MUST_NOT_EVALUATE");');
  };
  reset();let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/"evaluated": false/);
  fs.writeFileSync(path.join(root,deps[0]),'export const wrong=1;');
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/does not provide an export named/);
  reset();fs.unlinkSync(path.join(root,deps[0]));assert.notEqual(run().status,0);
  reset();fs.writeFileSync(path.join(root,deps[0]),'export const ok = ;');assert.notEqual(run().status,0);
  reset();fs.writeFileSync(path.join(dir,'outside.js'),'export const ok=1;');
  fs.writeFileSync(path.join(root,deps[0]),"export {ok} from '../../../outside.js';");
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/escapes asset directory/);
});
