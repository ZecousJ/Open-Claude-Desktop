/** Execute the actual close-registration source with an Electron-like dead getter. No app/UI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {EventEmitter} from 'node:events';
function fixture(legacy=false) {
 const source=fs.readFileSync('electron/official-ui/window.ts','utf8');
 const start=source.indexOf('    stage.attach(win);');
 const end=source.indexOf('    // The page recognises',start);
 assert.ok(start>=0&&end>start,'Exact production setup block must exist');
 const current=source.slice(start,end);
 const snippet=legacy?current.replace("windowRuntime.delete(contents)","windowRuntime.delete(win.webContents)"):current;
 if(legacy)assert.notEqual(snippet,current,"Legacy reproduction must replace the exact fixed expression");
 const contents=Object.assign(new EventEmitter(),{id:42});let dead=false;
 const win=new EventEmitter();
 Object.defineProperty(win,'webContents',{get(){if(dead)throw Error('Object has been destroyed');return contents;}});
 const runtime:{windows:Set<unknown>;ownerIds:Set<unknown>;layoutOwner?:typeof win}={windows:new Set(),ownerIds:new Set()}, officialWindows=new Map(),windowRuntime=new WeakMap(),managerOwnerBindings=new Map();
 const mainState:{window:any}={window:win};
 vm.runInNewContext(ts.transpile(snippet,{target:ts.ScriptTarget.ES2022}),{stage:{attach(){}},win,runtime,officialWindows,windowRuntime,managerOwnerBindings,mainState,options:{},hidden:true,applyZoom(){}});
 return {win,contents,runtime,officialWindows,windowRuntime,mainState,close(){dead=true;win.emit('closed');}};
}
test('actual closed callback never dereferences destroyed BrowserWindow and releases its own mappings',()=>{
 const f=fixture();assert.equal(f.windowRuntime.get(f.contents),f.runtime);
 assert.doesNotThrow(()=>f.close());
 assert.equal(f.windowRuntime.has(f.contents),false);assert.equal(f.runtime.windows.has(f.win),false);
 assert.equal(f.officialWindows.has(42),false);assert.equal(f.mainState.window,undefined);
 assert.equal(f.runtime.layoutOwner,undefined);
});
test('actual old close callback does not erase a replacement window with a reused numeric ID',()=>{
 const f=fixture();const replacement={};f.officialWindows.set(42,replacement);f.mainState.window=replacement;
 assert.doesNotThrow(()=>f.close());
 assert.equal(f.officialWindows.get(42),replacement);assert.equal(f.mainState.window,replacement);
 assert.equal(f.windowRuntime.has(f.contents),false);
});

test('in-memory original closed expression reproduces the exact destroyed-object exception',()=>{
 const f=fixture(true);assert.throws(()=>f.close(),/Object has been destroyed/);
 assert.equal(f.windowRuntime.has(f.contents),true);
 assert.equal(f.mainState.window,f.win,'original exception skips remaining cleanup');
});
