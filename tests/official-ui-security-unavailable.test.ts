import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import type http from 'node:http';
import { fixtureRoute } from '../electron/official-ui/api/fixtures';

const paths = ['/api/auth/mfa', '/api/auth/trusted_devices', '/api/account/deletion-allowed'];
async function request(path: string, method = 'GET') {
  let status = 0, body = '';
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (key: string, value: unknown) => { headers[key.toLowerCase()] = value; },
    writeHead: (code: number, values?: Record<string, unknown>) => {
      status = code;
      for (const [key, value] of Object.entries(values ?? {})) headers[key.toLowerCase()] = value;
    },
    end: (value?: string) => { body = value ?? ''; },
  } as unknown as http.ServerResponse;
  const handled = await fixtureRoute({ method } as http.IncomingMessage, res, path);
  return {handled, status, headers, body, data: body ? JSON.parse(body) : undefined};
}
test('security reads are unknown, not fabricated empty inventories or deletion permission', async () => {
  for (const path of paths) {
    const r = await request(path);
    assert.equal(r.handled, true);
    assert.equal(r.status, 503);
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.equal(r.data.type, 'error');
    assert.equal(r.data.error.type, 'api_error');
    for (const key of ['methods', 'devices', 'deletable', 'reasons']) assert.equal(Object.hasOwn(r.data, key), false);
    assert.match(r.data.error.details.error_code, /unavailable$/);
    assert.ok(r.data.error.message.includes('Claudex'));
  }
});
test('HEAD and unsupported mutation methods cannot manufacture success', async () => {
  for (const path of paths) for (const method of ['HEAD','POST','PUT','DELETE']) {
    const r = await request(path, method);
    assert.equal(r.status, method === 'HEAD' ? 503 : 501);
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.equal(r.data.type, 'error');
  }
});
test('unrelated routes fall through without security headers or output', async () => {
  const r = await request('/api/auth/unrelated');
  assert.equal(r.handled, false);
  assert.equal(r.status, 0);
  assert.deepEqual(r.headers, {});
});
const assets = '.restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/';
test('actual pinned API error parser and MFA predicate select unavailable branch', async () => {
  const source = fs.readFileSync(assets+'shared-l-p-m-w-0-C_nAiu5o.js', 'utf8');
  const mfa = fs.readFileSync(assets+'shared-m-2-DfdOu-fU.js', 'utf8');
  // Execute only isolated pure error class/parser/predicate, not module imports,
  // hooks, scripts, provider code or browser runtime.
  const cls = source.slice(source.indexOf('var _3 = class extends Error'),source.indexOf('  qA = class extends _3'));
  assert.ok(cls.startsWith('var _3 = class extends Error'));
  const parser = source.slice(source.indexOf('function XG({'),source.indexOf('function q8(e)'));
  const predicate = mfa.slice(mfa.indexOf('function pw(e) {'),mfa.indexOf('var T9 =',mfa.indexOf('function pw(e) {')));
  const context = vm.createContext({});
  vm.runInContext(cls.replace(/,\s*$/, ';')+parser+predicate+'; globalThis.parse=XG; globalThis.unavailable=pw;',context, {timeout: 1000});
  const result = await request('/api/auth/mfa');
  const error = context.parse({status:result.status,response:result.data});
  assert.equal(context.unavailable(error),true);
  assert.equal(error.errorCode,'mfa_unavailable');
  assert.equal(error.fromApiEnvelope,true);
  const generic = context.parse({status:503,response:{error:{type:'api_error',message:'Unavailable'}}});
  assert.equal(context.unavailable(generic),false);
});
test('pinned account consumer has explicit MFA/device error states; deletion fallback remains a UI gap', () => {
  const source = fs.readFileSync(assets+'c71860c77-pnODXvGc.js','utf8');
  assert.ok(source.includes('if (!r && !he(a)) return null;'));
  assert.ok(source.includes(': u(J, { id: "f93tl3" })'));
  assert.ok(source.includes('control: r\n                ? u(y,'));
  assert.ok(source.includes('return m && !f\n    ? u("div"'));
  assert.ok(source.includes('g.isSuccess && g.data?.deletable'));
  assert.ok(source.includes('href: "https://support.anthropic.com/"'));
});
