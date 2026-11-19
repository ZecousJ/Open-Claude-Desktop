const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const android = path.join(root, 'work/wt-android/mobile/android/app/src/main/assets/transcript-official');
const ios = path.join(root, 'work/wt-ios/mobile/ios/Claudex');
const viewport = fs.readFileSync(path.join(root, 'shared/mobile/native-viewport.js'), 'utf8');
assert.equal(fs.readFileSync(path.join(android, 'viewport.js'), 'utf8'), viewport);
assert.equal(fs.readFileSync(path.join(ios, 'Resources/TranscriptViewport.js'), 'utf8'), viewport);
async function check(platform) {
  const dom = new JSDOM('<html><head></head><body><div id="root" class="mode-chat"><div class="messages"><div class="turn"><div class="assistant-content"><div class="markdown">Reply</div><div class="turn-interrupted">Interrupted</div><div class="message-actions"><button class="small-action" aria-label="Copy">Copy</button><button id="retry" aria-label="Retry" disabled>Retry</button></div></div></div></div></div></body></html>', {runScripts:'outside-only'});
  const w = dom.window, frames = [];
  w.requestAnimationFrame = f => {frames.push(f); return frames.length;};
  w.webkit = {messageHandlers:{claudexTranscriptUI:{postMessage(){}}}};
  w.__oxOfficialConfig = {css:'',strings:{retry:'Retry',share:'Share'}};
  let source = fs.readFileSync(path.join(android, 'overlay.js'),'utf8');
  if(platform === 'ios') {
    const swift = fs.readFileSync(path.join(ios, 'UI/TranscriptOfficialStyle.swift'),'utf8');
    source = [...swift.matchAll(/#"""\n([\s\S]*?)\n"""#/g)].map(x=>x[1]).find(s=>s.includes('new MutationObserver'));
    source = source.replaceAll('__CLAUDEX_STRINGS__', JSON.stringify({retry:'Retry',share:'Share',incomplete:'Interrupted'})).replaceAll('__CLAUDEX_CSS__','""');
  }
  w.eval(source);
  w.document.getElementById('root').appendChild(w.document.createElement('span'));
  async function settle() {
    let count = 0;
    for(let i=0;i<20;i++) {
      await new Promise(resolve=>setImmediate(resolve));
      const f=frames.shift(); if(!f) return count;
      count++; f(i*16);
    }
    assert.fail(platform + ' keeps scheduling frames while idle');
  }
  const transitions=[];
  for(const disabled of [true,false,true,false]) {
    w.document.getElementById('retry').disabled = disabled;
    const frames = await settle();
    const retry = w.document.querySelector('.ox-secondary,.cx-notice-retry');
    assert.ok(retry); assert.equal(retry.disabled,disabled);
    transitions.push({disabled,frames});
  }
  dom.window.close(); return {platform,transitions};
}
(async()=> {console.log(JSON.stringify({overlayResults:await Promise.all([check('android'),check('ios')]),identicalViewportAssets:true},null,2));})().catch(e=>{console.error(e);process.exitCode=1;});
