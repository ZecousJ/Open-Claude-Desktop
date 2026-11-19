import test from 'node:test';
import assert from 'node:assert/strict';
import {safeActivationFailureSummary as summarize} from '../../electron/account/activation-failure';

test('fixed errno, HTTP status and exact built-in kinds include bounded fetch causes', () => {
  const leaf = Object.assign(new Error('SECRET path'), {code:'ECONNREFUSED',status:503});
  const outer = new TypeError('SECRET URL', {cause:leaf});
  assert.deepEqual(summarize(outer), [{kind:'TypeError'},{kind:'Error',code:'ECONNREFUSED',status:503}]);
  for (const code of ['ENOENT','EACCES','EPERM','EADDRINUSE','ECONNREFUSED','ETIMEDOUT','ECONNRESET','EISDIR','ENOTDIR','ENOSPC','EDQUOT','EROFS']) assert.equal(summarize({code})[0].code,code);
  for (const status of [100,599]) assert.equal(summarize({status})[0].status,status);
});
test('getters, inherited fields, arbitrary messages/codes and invalid status are never consumed', () => {
  let reads=0;
  const getters=Object.create({code:'ENOENT',status:200});
  for(const key of ['code','status','cause','message','stack','name']) Object.defineProperty(getters,key,{get(){reads++;throw Error('SECRET');}});
  assert.deepEqual(summarize(getters),[{kind:'unknown'}]);assert.equal(reads,0);
  for(const status of [99,600,NaN,Infinity,200.5,'200',null]) assert.deepEqual(summarize({status,code:'SECRET',message:'SECRET',stack:'SECRET'}),[{kind:'unknown'}]);
  assert.deepEqual(summarize(new (class extends TypeError {})('SECRET')),[{kind:'unknown'}]);
});
test('throwing/revoked proxies and hostile coercion fail closed without leaking or throwing', () => {
  const hostile={toString(){throw Error('SECRET')}};
  assert.deepEqual(summarize({code:hostile,status:hostile}),[{kind:'unknown'}]);
  for(const trap of ['getPrototypeOf','getOwnPropertyDescriptor']) {
    const proxy=new Proxy({}, {[trap](){throw Error('SECRET')}});
    assert.deepEqual(summarize(proxy),[{kind:'unknown'}]);
  }
  const {proxy,revoke}=Proxy.revocable({},{});revoke();assert.deepEqual(summarize(proxy),[{kind:'unknown'}]);
});
test('cause cycles and deep chains are bounded and output contains scalars only', () => {
  const cyclic:any={code:'ENOENT'};cyclic.cause=cyclic;
  assert.deepEqual(summarize(cyclic),[{kind:'unknown',code:'ENOENT'}]);
  const chain={cause:{cause:{cause:{code:'EACCES',message:'SECRET'}}}};
  assert.equal(summarize(chain).length,3);assert.doesNotMatch(JSON.stringify(summarize(chain)),/SECRET|EACCES|cause/);
  for(const value of [null,undefined,'SECRET',42,()=>{}]) assert.deepEqual(summarize(value),[{kind:'unknown'}]);
});
