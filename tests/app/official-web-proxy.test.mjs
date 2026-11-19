/** Agent identity composition only: no sockets, proxy requests or environment reads. */
import test from 'node:test';import assert from 'node:assert/strict';import {officialWebProxy} from '../../scripts/official-web-proxy.mjs';
test('candidate dev proxy reuses existing configured global agents and preserves original origin/cookie handlers',()=>{
 const configure=()=>{},https={},http={};const source={host:'127.0.0.1',port:5174,proxy:{'/api':{target:'https://fixture.invalid',configure,ws:true,changeOrigin:true},'/local':{target:'http://127.0.0.1:18080'}}};
 const r=officialWebProxy(source,{NODE_USE_ENV_PROXY:'1'},{http,https});assert.equal(r.proxy['/api'].agent,https);assert.equal(r.proxy['/local'].agent,http);assert.equal(r.proxy['/api'].configure,configure);assert.equal(r.host,'127.0.0.1');assert.equal(r.port,5174);assert.equal(source.proxy['/api'].agent,undefined);assert.equal(r.proxy['/api'].secure,undefined);
 assert.equal(officialWebProxy(source,{},{}),source);
});
test('candidate helper refuses insecure certificate override',()=>{
 assert.throws(()=>officialWebProxy({proxy:{'/api':{target:'https://fixture.invalid',secure:false}}},{NODE_USE_ENV_PROXY:'1'},{http:{},https:{}}));
});
