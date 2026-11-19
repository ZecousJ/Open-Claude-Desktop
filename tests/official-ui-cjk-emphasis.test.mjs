import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { cjkEmphasis, deriveCjkEmphasisModule, cjkEmphasisTarget } from '../scripts/official-ui-cjk-emphasis.mjs';

const root = path.resolve(process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? '.restore/archive-extracted', 'claude-frontend-4.4212.0/src/cloud/assets/v1');
test('original Markdown parser renders CJK punctuation before adjacent words as emphasis', async () => {
  const dom = new JSDOM('<!doctype html>', { url: 'https://fixture.invalid' });
  const saved = new Map();
  for (const key of ['window', 'document', 'navigator', 'Element', 'Node', 'HTMLElement', 'MutationObserver']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  try {
    const original = await import(path.join(root, 'vendor-markdown-Db8YGQLz.js'));
    const parse = (value) => {
      const p = original.Fj().use(original.eI).use(cjkEmphasis);
      return p.runSync(p.parse(value), { value });
    };
    for (const input of ['**型号：**PWM', '**型号： **PWM', '**型号：**中文']) {
      const children = parse(input).children[0].children;
      assert.equal(children[0].type, 'strong', input);
      assert.equal(children[0].children[0].value, '型号：');
    }
    assert.equal(parse('`**型号：**PWM`').children[0].children[0].type, 'inlineCode');
    assert.equal(parse('\\*\\*型号：**PWM').children[0].children[0].type, 'text');
    assert.equal(parse('**正常** text').children[0].children[0].type, 'strong');
    assert.equal(parse('**型号：**').children[0].children[0].type, 'strong');
    assert.equal(parse('**型号：').children[0].children[0].type, 'text');
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  }
});
test('original renderer installs the plugin once at its Markdown processor', () => {
  const input = fs.readFileSync(path.join(root, cjkEmphasisTarget), 'utf8');
  const result = deriveCjkEmphasisModule(cjkEmphasisTarget, input);
  assert.ok(result.includes('.use(cjkEmphasis)'));
  assert.throws(() => deriveCjkEmphasisModule(cjkEmphasisTarget, result), /anchor mismatch/);
});
