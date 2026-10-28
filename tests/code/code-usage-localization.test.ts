import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("actual Code statistics translate complete labels and keep the model name literal", () => {
  const script = `
    import {parseHTML} from 'linkedom';
    import {createElement} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {UsageOverview} from './src/code-home/UsageOverview.tsx';
    import {setLocale} from './src/i18n/index.ts';
    import {startDomTranslation} from './src/i18n/dom.ts';
    const {window,document}=parseHTML('<html><body></body></html>');
    Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1}});
    await setLocale('zh-CN');
    const now=Date.now();
    document.body.innerHTML=renderToStaticMarkup(createElement(UsageOverview,{conversations:[{id:'usage-probe',title:'Synthetic usage',mode:'code',providerId:'test',model:'Settings',pinned:false,archived:false,createdAt:now,updatedAt:now,turns:[{id:'turn',prompt:'test',attachments:[],items:[],status:'completed',createdAt:now,inputTokens:100,outputTokens:10}]}]}));
    startDomTranslation();
    await new Promise(resolve=>setImmediate(resolve));
    console.log(JSON.stringify({labels:[...document.querySelectorAll('.usage-grid > div > span')].map(e=>e.textContent),values:[...document.querySelectorAll('.usage-grid strong')].map(e=>({text:e.textContent,protected:e.hasAttribute('data-no-translate')}))}));
  `;
  const actual = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/support/css-stub.mjs",
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: new URL("../../", import.meta.url), encoding: "utf8" },
    ),
  );
  assert.deepEqual(actual.labels, [
    "会话",
    "消息",
    "总 Token 数",
    "活跃天数",
    "最活跃时段",
    "最常用模型",
  ]);
  assert.equal(actual.values.at(-1).text, "Settings");
  assert.ok(
    actual.values.every((value: { protected: boolean }) => value.protected),
  );
});
