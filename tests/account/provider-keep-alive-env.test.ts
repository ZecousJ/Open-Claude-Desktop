import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync('electron/app/keep-alive.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture(optIn: string | undefined) {
  const inherited = Object.freeze({ existing: true });
  let dispatcher: unknown = inherited;
  const created: unknown[] = [];
  const exports: any = {};
  const env = Object.freeze({ NODE_USE_ENV_PROXY: optIn, HTTPS_PROXY: 'inert-do-not-read', NO_PROXY: 'unchanged' });
  vm.runInNewContext(compiled, { exports, process: { env }, require(name: string) {
    assert.equal(name, 'undici');
    return { Agent: class { constructor(options: unknown) { created.push(options); } },
      setGlobalDispatcher(value: unknown) { dispatcher = value; } };
  } });
  return { run: exports.keepConnectionsOpen as () => void, inherited, created, current: () => dispatcher };
}
test('explicit env-proxy opt-in preserves exact runtime dispatcher without constructing or replacing it', () => {
  const f = fixture('1');
  f.run(); f.run();
  assert.equal(f.current(), f.inherited);
  assert.deepEqual(f.created, []);
});
test('default and non-opt-in values retain existing keep-alive behavior', () => {
  for (const value of [undefined, '', '0', 'true']) {
    const f = fixture(value); f.run();
    assert.notEqual(f.current(), f.inherited);
    assert.equal(f.created.length, 1);
    assert.equal(JSON.stringify(f.created[0]), JSON.stringify({ keepAliveTimeout: 100_000, keepAliveMaxTimeout: 100_000 }));
  }
});
