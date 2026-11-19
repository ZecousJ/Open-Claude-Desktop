import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from './harness.mjs';
const manifest = JSON.parse(await fs.readFile(new URL('../../docs/official-ui-static-assets.json',import.meta.url),'utf8'));
assert.equal(manifest.failures.length,0);
const client = await Client.launch();
const results = [];
try {
  const page = client.page(0);
  for(const asset of manifest.assets) {
    const response = await fetch(client.origin+asset.path,{headers:{Cookie:client.cookie}});
    assert.equal(response.status,200,asset.path);
    assert.equal(response.headers.get('content-type'),asset.mime,asset.path);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256,asset.path);
    const decoded = await page.eval('(async()=>{const image=new Image(); image.src='+JSON.stringify(asset.path)+'; try { await image.decode(); return {width:image.naturalWidth,height:image.naturalHeight}; } catch(error) { return {error:String(error)}; } finally { image.src=""; }})()');
    assert.ok(decoded.width>0 && decoded.height>0,asset.path+': '+JSON.stringify(decoded));
    results.push({path:asset.path,sha256:asset.sha256,...decoded,completedAt:new Date().toISOString()});
  }
  console.log(JSON.stringify({result:'passed for available pinned assets',completedAt:new Date().toISOString(),count:results.length,unavailable:manifest.unavailable??[],scope:'Packaged authenticated loopback HTTP, exact pinned bytes, MIME and Chromium image decoding; unavailable upstream assets explicitly excluded; no model sends'}));
} finally {
  await fs.writeFile(process.env.STATIC_IMAGE_RESULTS??'/tmp/claudex-static-images-results.json',JSON.stringify(results,null,2));
  await client.stop();
}
