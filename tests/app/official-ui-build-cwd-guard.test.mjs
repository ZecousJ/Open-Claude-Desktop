import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=path.resolve('scripts/build-official-ui.mjs');
const source=fs.readFileSync(script,'utf8');
const guardEnd=source.indexOf('const { applyOfficialUiHostFeedbackOutcome }');
assert.ok(guardEnd>0);
function snapshot(root){const rows=[];function walk(p){for(const name of fs.readdirSync(p).sort()){const q=path.join(p,name),s=fs.lstatSync(q);rows.push([path.relative(root,q),s.isDirectory()?'dir':s.isSymbolicLink()?'link':fs.readFileSync(q,'utf8')]);if(s.isDirectory())walk(q);}}walk(root);return rows;}
test('actual assembler refuses wrong cwd before loading project modules or writing any files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'official-cwd-'));
 try{
  const cwd=path.join(root,'caller'),stage=path.join(root,'stage');fs.mkdirSync(cwd);fs.mkdirSync(path.join(stage,'scripts'),{recursive:true});
  const copy=path.join(stage,'scripts/build-official-ui.mjs');fs.writeFileSync(copy,source);
  fs.mkdirSync(path.join(cwd,'build/official-ui'),{recursive:true});fs.writeFileSync(path.join(cwd,'build/official-ui/sentinel.txt'),'unchanged');
  const before=snapshot(root);
  // Full real entry bytes, but deliberately no local dependency modules exist.
  // A dependency import before the guard would fail differently and fail this test.
  const result=spawnSync(process.execPath,[copy,'--no-build'],{cwd,env:{...process.env,CLAUDEX_OFFICIAL_UI_SOURCE:path.join(root,'must-not-read')},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Official UI assembly refused/);assert.doesNotMatch(result.stderr,/ERR_MODULE_NOT_FOUND|recovered user-content/);
  assert.deepEqual(snapshot(root),before);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('exact guard accepts own real project root including symlink cwd, without executing assembly',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'official-cwd-valid-'));
 try{
  const stage=path.join(root,'stage');fs.mkdirSync(path.join(stage,'scripts'),{recursive:true});
  const copy=path.join(stage,'scripts/build-official-ui.mjs');fs.writeFileSync(copy,source.slice(0,guardEnd)+'console.log("guard accepted; assembly not executed");\n');
  fs.symlinkSync(stage,path.join(root,'alias'),'dir');
  for(const cwd of [stage,path.join(root,'alias')]){
   const before=snapshot(root);const result=spawnSync(process.execPath,[copy],{cwd,encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/guard accepted/);assert.deepEqual(snapshot(root),before);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('no project import or assembly source read precedes cwd guard',()=>{
 const prefix=source.slice(0,guardEnd);
 assert.equal(/from ["']\.\//.test(prefix),false);assert.equal(/await import\(/.test(prefix),false);
 assert.equal(/(?:readFile|writeFile|cpSync|rmSync|existsSync|mkdirSync)/.test(prefix),false);
 assert.ok(source.indexOf('const source = path.resolve(')>guardEnd);
});
