/** Pure literal parser only. Never starts Electron or reads real environment configuration. */
import test from 'node:test';import assert from 'node:assert/strict';
import {acceptanceEnvironment} from '../../scripts/launch-official-acceptance.mjs';
const source='HTTP_PROXY="http://fixture.invalid:8889"\nHTTPS_PROXY=http://fixture.invalid:8889\nNO_PROXY=localhost,127.0.0.1\nNODE_EXTRA_CA_CERTS=/fixture/ca.pem\nSSL_CERT_FILE=/fixture/ca.pem';
test('launcher preserves exact existing proxy/no-proxy/CA without insecure flags',()=>{
 const env=acceptanceEnvironment(source,{KEEP:'same',https_proxy:'old'});assert.equal(env.HTTPS_PROXY,'http://fixture.invalid:8889');assert.equal(env.https_proxy,env.HTTPS_PROXY);assert.equal(env.NO_PROXY,'localhost,127.0.0.1');assert.equal(env.NODE_EXTRA_CA_CERTS,'/fixture/ca.pem');assert.equal(env.KEEP,'same');assert.equal(env.NODE_USE_ENV_PROXY,'1');assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
});
test('launcher rejects missing, ambiguous, shell expansion and insecure inherited configuration',()=>{
 for(const text of ['',source+'\nHTTP_PROXY=http://other.invalid',source.replace('localhost,127.0.0.1','$(command)')])assert.throws(()=>acceptanceEnvironment(text,{}));
 assert.throws(()=>acceptanceEnvironment(source,{NODE_TLS_REJECT_UNAUTHORIZED:'0'}));
 assert.throws(()=>acceptanceEnvironment(source,{NODE_OPTIONS:'--no-sandbox'}));
});
