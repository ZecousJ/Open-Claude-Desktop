import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { act, createElement, useState, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { PluginDiscover } from "../../src/plugins/PluginDiscover";
import { SkillDetail } from "../../src/collections/customize/SkillDetail";
import type {
  CustomizeSkill,
  SkillContents,
} from "../../shared/collections-api";
import type { SkillDetailView } from "../../src/collections/customize/InstalledSkillPage";
import { customizePath } from "../../src/web/customize-route";
import {
  skillFileTree,
  clampSkillFileListWidth,
} from "../../src/collections/customize/skill-file-tree";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";

async function mounted(
  node: ReactNode,
  run: (document: Document) => Promise<void>,
  desktop: Record<string, unknown> = {},
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.assign(window, { desktop });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const before = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => root.render(node));
    for (let count = 0; count < 8; count++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    await run(document as unknown as Document);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of before)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

test("Discover Show all names identify each curated shelf on both Skills and Plugins", () => {
  const plugin = (index: number) => ({
    id: `p${index}@market`,
    name: `p${index}`,
    title: `Plugin ${index}`,
    marketplace: "market",
    marketplacePath: "/market",
    installed: false,
    enabled: true,
    installable: true,
    source: "git" as const,
  });
  const entries = Array.from({ length: 8 }, (_, index) => plugin(index));
  for (const noun of ["skills", "plugins"] as const) {
    const { document } = parseHTML(
      renderToStaticMarkup(
        createElement(PluginDiscover, {
          entries,
          noun,
          curation: { newest: entries, popular: entries.slice(0, 7) },
          onOpen() {},
          onInstall: async () => [],
          onError() {},
          renderRows: (rows) =>
            createElement(
              "ul",
              null,
              rows.map((row) =>
                createElement("li", { key: row.id }, row.title),
              ),
            ),
          emptyMessage: "",
        }),
      ),
    );
    assert.ok(
      document.querySelector(`button[aria-label="Show all: New ${noun}"]`),
    );
    assert.ok(
      document.querySelector(
        `button[aria-label="Show all: Most installed ${noun}"]`,
      ),
    );
    assert.equal(document.querySelectorAll("li").length, 12);
  }
});

test("skill page metrics follow the observed web shell and remain in a private lazy sheet", () => {
  const css = readFileSync(
    "src/collections/customize/installed-skill-page.css",
    "utf8",
  );
  const rule = (selector: string) =>
    css.match(
      new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]+)\\}`,
      ),
    )![1];
  assert.match(rule(".installed-skill-back"), /height:\s*28px;/);
  assert.match(rule(".installed-skill-back"), /font-size:\s*14px;/);
  assert.match(rule(".installed-skill-icon"), /flex:\s*0 0 44px;/);
  assert.match(rule(".installed-skill-icon"), /border-radius:\s*12px;/);
  assert.match(rule(".installed-skill-identity h2"), /font-size:\s*15px;/);
  assert.match(rule(".installed-skill-identity h2"), /line-height:\s*20px;/);
  assert.match(rule(".installed-skill-identity h2"), /font-weight:\s*580;/);
  assert.match(rule(".installed-skill-identity p"), /font-size:\s*13px;/);
  assert.match(rule(".installed-skill-identity p"), /line-height:\s*17px;/);
  assert.match(rule(".installed-skill-try"), /height:\s*32px;/);
  assert.match(rule(".installed-skill-try"), /padding:\s*0 12px;/);
  assert.match(rule(".installed-skill-switch"), /width:\s*32px;/);
  assert.match(rule(".installed-skill-switch"), /height:\s*18px;/);
  assert.match(rule(".installed-skill-more"), /width:\s*32px;/);
  assert.match(rule(".installed-skill-more"), /height:\s*32px;/);
  assert.match(
    rule(".installed-skill-overview"),
    /grid-template-columns:\s*minmax\(0, 1fr\) 240px;/,
  );
  assert.match(rule(".installed-skill-overview"), /gap:\s*28px;/);
  assert.match(
    rule(".installed-skill-overview section > p"),
    /margin:\s*12px 0 0;/,
  );
  assert.match(
    rule(".installed-skill-overview section > p"),
    /line-height:\s*20px;/,
  );
  assert.doesNotMatch(
    rule(".installed-skill-overview section > p"),
    /(?:^|;)\s*(?:min-|max-)?height\s*:/,
  );
  assert.match(rule(".customize-skill-scroll"), /padding-bottom:\s*24px;/);
  assert.match(rule(".installed-skill-content-view"), /flex:\s*1;/);
  assert.match(rule(".installed-skill-content-view"), /gap:\s*16px;/);
  assert.match(rule(".installed-skill-content-view"), /min-height:\s*0;/);
  assert.match(rule(".installed-skill-file-toolbar"), /height:\s*32px;/);
  assert.match(rule(".installed-skill-contents"), /flex:\s*1;/);
  assert.match(rule(".installed-skill-contents"), /border-radius:\s*12px;/);
  assert.doesNotMatch(
    rule(".installed-skill-contents"),
    /(?:^|;)\s*height\s*:/,
  );
  const owner = readFileSync(
    "src/collections/customize/SkillDetail.tsx",
    "utf8",
  );
  assert.match(
    owner,
    /lazyPiece\(\s*\(\) => import\("\.\/InstalledSkillPage"\)/,
  );
  assert.doesNotMatch(owner, /import ["']\.\/installed-skill-page\.css["']/);
});

test("Customize Add retains the observed 32px shared control metrics", () => {
  const css = readFileSync("src/collections/customize/customize.css", "utf8");
  const add = css.match(
    /\.customize-tools > \.customize-add\s*\{([^}]+)\}/,
  )![1];
  assert.match(add, /height:\s*32px;/);
  assert.match(add, /padding:\s*0 12px;/);
  assert.match(add, /font-size:\s*14px;/);
  assert.match(add, /line-height:\s*20px;/);
  assert.match(add, /font-weight:\s*500;/);
  assert.match(add, /gap:\s*4px;/);
});

const skill: CustomizeSkill = {
  name: "Settings",
  description: "Search",
  path: "/skills/settings/SKILL.md",
  scope: "user",
  own: true,
  enabled: true,
};
const contents: SkillContents = {
  markdown: "MAIN_BODY",
  files: [
    { path: "SKILL.md", bytes: 9 },
    { path: "examples/input.txt", bytes: 15 },
    { path: "references/Settings.md", bytes: 17 },
    { path: "image.bin", bytes: 2 },
  ],
  truncated: false,
};

function SkillHarness({
  initial = skill,
  initialView = "overview",
  onBack = () => {},
  onTry = () => {},
  onToggle = async () => {},
  onReveal,
  onRemove = () => {},
  onDuplicate = () => {},
}: {
  initial?: CustomizeSkill;
  initialView?: SkillDetailView;
  onBack?: () => void;
  onTry?: () => void;
  onToggle?: () => Promise<void>;
  onReveal?: () => void;
  onRemove?: () => void;
  onDuplicate?: () => void;
}) {
  const [view, setView] = useState<SkillDetailView>(initialView);
  return createElement(SkillDetail, {
    skill: initial,
    added: true,
    busy: false,
    onClose: onBack,
    onAdd: async () => {},
    onTry,
    onToggle,
    onReveal,
    onRemove,
    onDuplicate,
    page: {
      view,
      onViewChange: setView,
      links: {
        back: customizePath({ section: "skills", view: "yours" }),
        overview: customizePath({
          section: "skills",
          view: "yours",
          detailId: initial.name,
        }),
        contents: customizePath({
          section: "skills",
          view: "yours",
          detailId: initial.name,
          detailView: "contents",
        }),
      },
    },
  });
}

test("installed skill page has real routes, a data heading, dynamic files and genuine action placement", async () => {
  let backs = 0,
    tries = 0,
    duplicates = 0;
  await mounted(
    createElement(SkillHarness, {
      onBack: () => backs++,
      onTry: () => tries++,
      onDuplicate: () => duplicates++,
    }),
    async (document) => {
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(
        document.querySelector("h2[data-no-translate]")?.textContent,
        skill.name,
      );
      assert.equal(
        document.querySelector(".installed-skill-overview p[data-no-translate]")
          ?.textContent,
        skill.description,
      );
      assert.equal(
        document.querySelector(".installed-skill-overview aside > span")
          ?.textContent,
        "You",
      );
      assert.ok(
        document.querySelector('.installed-skill-icon [data-icon="Scroll"]'),
      );
      assert.equal(
        document.querySelector(".installed-skill-back")?.getAttribute("href"),
        "/customize/skills/yours",
      );
      const tabs = document.querySelectorAll(".installed-skill-tabs > a");
      assert.equal(
        tabs[0].getAttribute("href"),
        "/customize/skills/yours/id/Settings",
      );
      assert.equal(
        tabs[1].getAttribute("href"),
        "/customize/skills/yours/id/Settings/contents",
      );
      assert.equal(tabs[1].textContent, "Contents · 4");
      assert.equal(
        document.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
        "true",
      );
      await act(async () => {
        (
          document.querySelector(".installed-skill-try") as HTMLButtonElement
        ).click();
        (
          document.querySelector(".installed-skill-more") as HTMLButtonElement
        ).click();
      });
      assert.equal(tries, 1);
      const duplicate = Array.from(
        document.querySelectorAll('[role="menuitem"]'),
      ).find((item) =>
        item.textContent?.includes("Duplicate"),
      ) as HTMLButtonElement;
      assert.ok(duplicate);
      await act(async () => duplicate.click());
      assert.equal(duplicates, 1);
      await act(async () =>
        (
          document.querySelector(".installed-skill-more") as HTMLButtonElement
        ).click(),
      );
      assert.ok(document.querySelector('[role="menu"]'));
      await act(async () =>
        (
          document.querySelector(
            '.installed-skill-tabs a[href$="/contents"]',
          ) as HTMLAnchorElement
        ).click(),
      );
      assert.equal(document.querySelector('[role="menu"]'), null);
      assert.equal(
        document.querySelector(".installed-skill-file-toolbar")?.textContent,
        "Settings · current",
      );
      assert.equal(
        document.querySelector(".installed-skill-file-toolbar button"),
        null,
      );
      assert.equal(
        document
          .querySelector('.installed-skill-tabs a[aria-current="page"]')
          ?.getAttribute("href"),
        "/customize/skills/yours/id/Settings/contents",
      );
      await act(async () =>
        (
          document.querySelector(".installed-skill-back") as HTMLAnchorElement
        ).click(),
      );
      assert.equal(backs, 1);
    },
    { readSkill: async () => contents },
  );
});

test("skill file tree preserves actual paths and the observed resize bounds", () => {
  const tree = skillFileTree([
    "examples/z.txt",
    "SKILL.md",
    "readme.txt",
    "examples/a.txt",
    "SKILL.md",
  ]);
  assert.deepEqual(tree.files, ["SKILL.md", "readme.txt"]);
  assert.deepEqual(tree.folders[0].files, ["examples/a.txt", "examples/z.txt"]);
  assert.equal(clampSkillFileListWidth(0, 960), 160);
  assert.equal(clampSkillFileListWidth(1000, 960), 520);
  assert.equal(clampSkillFileListWidth(500, 600), 360);
  assert.equal(clampSkillFileListWidth(Number.NaN, 960), 244);
});

test("Contents uses real file reads, ignores late selection responses and keeps binary/error states truthful", async () => {
  let resolveOld!: (value: {
    text: string;
    binary: boolean;
    truncated: boolean;
  }) => void;
  let fails = true;
  const requests: string[] = [];
  await mounted(
    createElement(SkillHarness, { initialView: "contents" }),
    async (document) => {
      assert.match(
        document.querySelector(".skill-detail-markdown")?.textContent ?? "",
        /MAIN_BODY/,
      );
      const select = async (name: string) => {
        await act(async () => {
          (
            Array.from(
              document.querySelectorAll(
                ".installed-skill-contents li > button",
              ),
            ).find((button) =>
              button.textContent?.endsWith(name),
            ) as HTMLButtonElement
          ).click();
        });
      };
      await select("input.txt");
      assert.ok(
        document.querySelector('.installed-skill-reader [role="status"]'),
      );
      await select("Settings.md");
      assert.match(
        document.querySelector('.installed-skill-reader [role="alert"]')
          ?.textContent ?? "",
        /read failed/,
      );
      await act(async () => {
        (
          document.querySelector(
            '.installed-skill-reader [role="alert"] button',
          ) as HTMLButtonElement
        ).click();
      });
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /CURRENT_FILE/,
      );
      await act(async () =>
        resolveOld({ text: "STALE_FILE", binary: false, truncated: false }),
      );
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /STALE_FILE/,
      );
      await select("image.bin");
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /isn’t text/,
      );
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /CURRENT_FILE/,
      );
      assert.ok(
        requests.every((request) => request.startsWith(`${skill.path}:`)),
      );
    },
    {
      readSkill: async () => contents,
      readSkillFile: async (path: string, file: string) => {
        requests.push(`${path}:${file}`);
        if (file === "examples/input.txt")
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        if (file === "references/Settings.md" && fails) {
          fails = false;
          throw new Error("read failed");
        }
        return {
          text: file === "image.bin" ? "" : "CURRENT_FILE",
          binary: file === "image.bin",
          truncated: false,
        };
      },
    },
  );
});

test("empty skills stay empty while malformed/rejected contents remain recoverable errors", async (context) => {
  await context.test("real empty array", async () => {
    await mounted(
      createElement(SkillHarness, { initialView: "contents" }),
      async (document) => {
        assert.match(
          document.querySelector('[role="status"]')?.textContent ?? "",
          /No files to show/,
        );
        assert.equal(
          document.querySelector('.installed-skill-tabs a[aria-current="page"]')
            ?.textContent,
          "Contents",
        );
        assert.equal(document.querySelector(".installed-skill-reader"), null);
      },
      {
        readSkill: async () => ({ markdown: "", files: [], truncated: false }),
      },
    );
  });
  for (const failure of [
    undefined,
    { markdown: "", files: [null], truncated: false },
    new Error("inventory failed"),
  ]) {
    await context.test(
      failure instanceof Error
        ? "rejected"
        : failure === undefined
          ? "undefined"
          : "malformed row",
      async () => {
        let reads = 0;
        await mounted(
          createElement(SkillHarness, { initialView: "contents" }),
          async (document) => {
            assert.ok(
              document.querySelector(
                '.installed-skill-load-error[role="alert"]',
              ),
            );
            assert.equal(
              document.querySelector(
                '.installed-skill-tabs a[aria-current="page"]',
              )?.textContent,
              "Contents",
            );
            assert.equal(
              document.querySelector(".installed-skill-reader"),
              null,
            );
            await act(async () =>
              (
                document.querySelector(
                  ".installed-skill-load-error button",
                ) as HTMLButtonElement
              ).click(),
            );
            assert.equal(reads, 2);
            assert.match(
              document.querySelector(".skill-detail-markdown")?.textContent ??
                "",
              /MAIN_BODY/,
            );
          },
          {
            readSkill: async () => {
              if (++reads > 1) return contents;
              if (failure instanceof Error) throw failure;
              return failure;
            },
          },
        );
      },
    );
  }
});

test("skill switches do not claim failed updates and host-only/owned actions stay gated", async () => {
  let reject!: (error: Error) => void;
  let tries = 0;
  await mounted(
    createElement(SkillHarness, {
      onToggle: () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
      onTry: () => tries++,
    }),
    async (document) => {
      const toggle = document.querySelector(
        '[role="switch"]',
      ) as HTMLButtonElement;
      const tryButton = document.querySelector(
        ".installed-skill-try",
      ) as HTMLButtonElement;
      await act(async () => toggle.click());
      assert.equal(toggle.disabled, true);
      assert.equal(tryButton.disabled, true);
      assert.equal(toggle.getAttribute("aria-checked"), "true");
      await act(async () => reject(new Error("write failed")));
      assert.equal(toggle.disabled, false);
      assert.equal(toggle.getAttribute("aria-checked"), "true");
      assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /write failed/,
      );
      await act(async () => tryButton.click());
      assert.equal(tries, 1);
    },
    { readSkill: async () => contents },
  );
  await mounted(
    createElement(SkillHarness, {
      initial: { ...skill, own: false, scope: "system", enabled: false },
      onTry: () => tries++,
    }),
    async (document) => {
      const tryButton = document.querySelector(
        ".installed-skill-try",
      ) as HTMLButtonElement;
      assert.equal(tryButton.disabled, true);
      await act(async () => {
        tryButton.click();
        (
          document.querySelector(".installed-skill-more") as HTMLButtonElement
        ).click();
      });
      assert.equal(tries, 1);
      const menu = document.querySelector('[role="menu"]')?.textContent ?? "";
      assert.match(menu, /Duplicate/);
      assert.doesNotMatch(menu, /Rename|Remove|Show in folder/);
    },
    { readSkill: async () => contents },
  );
});

test("actual DOM translation preserves skill names, descriptions and file accessible names", () => {
  const script = `
    const {parseHTML}=await import('linkedom');
    const {window,document}=parseHTML('<html><body></body></html>');
    Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1}});
    const {createElement,Fragment}=await import('react');
    const {renderToStaticMarkup}=await import('react-dom/server');
    const {InstalledSkillPage}=await import('./src/collections/customize/InstalledSkillPage.tsx');
    const {setLocale}=await import('./src/i18n/index.ts');
    const {startDomTranslation}=await import('./src/i18n/dom.ts');
    await setLocale('zh-CN');
    const skill={name:'Settings',description:'Search',path:'/skill/SKILL.md',scope:'user',own:true,enabled:true};
    const props={skill,contents:{markdown:'BODY',files:[{path:'Search',bytes:4}],truncated:false},error:'',onReload(){},onViewChange(){},links:{back:'/customize/skills/yours',overview:'/customize/skills/yours/id/Settings',contents:'/customize/skills/yours/id/Settings/contents'},onBack(){},onTry(){},onToggle:async()=>{},onRemove(){},onDuplicate(){}};
    document.body.innerHTML=renderToStaticMarkup(createElement(Fragment,null,createElement(InstalledSkillPage,{...props,view:'overview'}),createElement(InstalledSkillPage,{...props,view:'contents'})));
    startDomTranslation();
    const page=document.querySelector('.installed-skill-page'),reader=document.querySelector('.installed-skill-reader');
    const more=document.getElementById(page.querySelector('.installed-skill-more').getAttribute('aria-labelledby')).textContent;
    const fileName=document.getElementById(reader.getAttribute('aria-labelledby')).textContent;
    console.log(JSON.stringify({title:page.querySelector('h2').textContent,description:page.querySelector('.installed-skill-overview p').textContent,more,fileName,tryLabel:page.querySelector('.installed-skill-try').textContent,creator:page.querySelector('aside>span').textContent}));
  `;
  const result = JSON.parse(
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
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  assert.equal(result.title, "Settings");
  assert.equal(result.description, "Search");
  assert.equal(result.fileName, "Search");
  assert.ok(result.more.includes("Settings"));
  assert.ok(!result.more.includes("设置"));
  assert.ok(!result.tryLabel.includes("Try in chat"));
  assert.equal(result.creator, "您");
});

test("real rendered SKILL.md, other Markdown and legacy modal instructions remain user data across locales", () => {
  const script = `
    const {parseHTML}=await import('linkedom');
    const {window,document}=parseHTML('<html><body><main></main></body></html>');
    Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1},innerWidth:1440,innerHeight:900,requestAnimationFrame:cb=>setTimeout(()=>cb(0),0),cancelAnimationFrame:clearTimeout,IS_REACT_ACT_ENVIRONMENT:true});
    const {createElement,Fragment,act}=await import('react');
    const {createRoot}=await import('react-dom/client');
    const {InstalledSkillPage}=await import('./src/collections/customize/InstalledSkillPage.tsx');
    const {SkillDetail}=await import('./src/collections/customize/SkillDetail.tsx');
    const {setLocale}=await import('./src/i18n/index.ts');
    const {startDomTranslation}=await import('./src/i18n/dom.ts');
    const body='Settings\\n\\nSearch\\n\\n'+String.fromCharCode(96).repeat(3)+'txt\\nSettings\\nSearch\\n'+String.fromCharCode(96).repeat(3);
    const contents={markdown:body,files:[{path:'SKILL.md',bytes:30},{path:'Other.md',bytes:30}],truncated:false};
    window.desktop={readSkill:async()=>contents,readSkillFile:async()=>({text:contents.markdown,binary:false,truncated:false}),copyText:async()=>{}};
    const skill={name:'Settings',description:'Search',path:'/skill/SKILL.md',scope:'user',own:true,enabled:true};
    const shared={onTry(){},onRemove(){},onToggle:async()=>{}};
    const page={skill,contents,error:'',onReload(){},view:'contents',onViewChange(){},links:{back:'/customize/skills/yours',overview:'/customize/skills/yours/id/Settings',contents:'/customize/skills/yours/id/Settings/contents'},onBack(){},onDuplicate(){},...shared};
    const root=createRoot(document.querySelector('main'));
    await act(async()=>root.render(createElement(Fragment,null,createElement(InstalledSkillPage,page),createElement(SkillDetail,{skill,added:true,busy:false,onClose(){},onAdd:async()=>{},...shared}))));
    for(let i=0;i<4;i++)await act(async()=>await new Promise(resolve=>setTimeout(resolve,10)));
    await act(async()=>await setLocale('zh-CN'));startDomTranslation();
    const bodies=()=>[...document.querySelectorAll('.skill-detail-markdown')].map(node=>node.textContent);
    const first=bodies(),copyLabel=document.querySelector('[data-testid="code-block-copy"]').getAttribute('aria-label');
    const other=[...document.querySelectorAll('.installed-skill-contents li>button')].find(node=>node.textContent.endsWith('Other.md'));
    await act(async()=>other.click());
    for(let i=0;i<4;i++)await act(async()=>await new Promise(resolve=>setTimeout(resolve,10)));
    const next=bodies();
    await act(async()=>await setLocale('en-US'));
    const english=bodies(),tryLabel=document.querySelector('.installed-skill-try').textContent;
    await act(async()=>root.unmount());
    console.log(JSON.stringify({first,next,english,copyLabel,tryLabel}));
  `;
  const result = JSON.parse(
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
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  for (const phase of [result.first, result.next, result.english]) {
    assert.equal(phase.length, 2);
    for (const text of phase) {
      assert.match(text, /Settings/);
      assert.match(text, /Search/);
      assert.doesNotMatch(text, /设置|搜索/);
    }
  }
  assert.notEqual(result.copyLabel, "Copy to clipboard");
  assert.ok(result.tryLabel.includes("Try in chat"));
});

test("the Contents splitter changes real layout state with keyboard bounds and reset", async () => {
  await mounted(
    createElement(SkillHarness, { initialView: "contents" }),
    async (document) => {
      const handle = document.querySelector(
        '[role="separator"][aria-label="Resize file list"]',
      ) as HTMLElement;
      assert.ok(handle);
      const frame = document.querySelector(".installed-skill-contents")!;
      Object.defineProperty(frame, "getBoundingClientRect", {
        value: () => ({ width: 600 }),
      });
      const press = async (key: string, shiftKey = false) => {
        await act(async () => {
          const event = new Event("keydown", {
            bubbles: true,
            cancelable: true,
          });
          Object.assign(event, { key, shiftKey });
          handle.dispatchEvent(event);
        });
      };
      assert.equal(handle.getAttribute("aria-valuenow"), "244");
      await press("ArrowRight");
      assert.equal(handle.getAttribute("aria-valuenow"), "252");
      await press("ArrowRight", true);
      assert.equal(handle.getAttribute("aria-valuenow"), "284");
      await press("End");
      assert.equal(handle.getAttribute("aria-valuenow"), "360");
      await press("Home");
      assert.equal(handle.getAttribute("aria-valuenow"), "160");
      await press("Enter");
      assert.equal(handle.getAttribute("aria-valuenow"), "244");
      assert.match(
        frame.getAttribute("style") ?? "",
        /--skill-file-list-width:\s*244px/,
      );
    },
    { readSkill: async () => contents },
  );
});

test("offline skill fixtures provide explicit synthetic contents and guard unknown paths without changing capabilities", async () => {
  const params = new URLSearchParams("skills=some");
  const bridge = createFixtureDesktop({ history: "empty" }, params);
  const independent = createFixtureDesktop({ history: "empty" }, params);
  const host = structuredClone((await bridge.snapshot()).host);
  const listed = await bridge.customizeSkills();
  const owned = listed.find((entry) => entry.own)!;
  const builtin = listed.find((entry) => entry.name === "plan-review")!;
  const ownedContents = await bridge.readSkill(owned.path);
  assert.equal(ownedContents.files.length, 3);
  assert.equal((await bridge.readSkill(builtin.path)).files.length, 1);
  for (const file of ownedContents.files) {
    const raw = await bridge.readSkillFile(owned.path, file.path);
    assert.equal(raw.binary, false);
    assert.equal(raw.truncated, false);
    assert.equal(file.bytes, new TextEncoder().encode(raw.text).length);
    assert.match(raw.text, /[Ss]ynthetic/);
  }
  const source = await bridge.readSkillFile(owned.path, "SKILL.md");
  assert.equal(
    source.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
    ownedContents.markdown,
  );
  await assert.rejects(
    bridge.readSkill("/not-listed/SKILL.md"),
    /not in the offline fixture/,
  );
  await assert.rejects(
    bridge.readSkillFile(owned.path, "../private.txt"),
    /not in the offline skill bundle/,
  );
  await bridge.setSkillEnabled(owned.path, false);
  assert.equal(
    (await bridge.customizeSkills()).find((entry) => entry.path === owned.path)
      ?.enabled,
    false,
  );
  assert.equal(
    (await independent.customizeSkills()).find(
      (entry) => entry.path === owned.path,
    )?.enabled,
    true,
  );
  const native = (await bridge.listSkills())
    .flatMap((group) => group.skills)
    .find((entry) => entry.name === "skill-creator");
  assert.ok(native);
  assert.equal((await bridge.readSkill(native.path)).files.length, 6);
  await bridge.setSkillEnabled(native.path, false);
  assert.equal(
    (await bridge.customizeSkills()).find((entry) => entry.path === native.path)
      ?.enabled,
    false,
  );
  assert.equal(
    (await bridge.listSkills())
      .flatMap((group) => group.skills)
      .find((entry) => entry.path === native.path)?.enabled,
    false,
  );
  await assert.rejects(bridge.deleteSkill(native.path), /cannot be removed/);
  await bridge.deleteSkill(owned.path);
  assert.ok(
    !(await bridge.customizeSkills()).some(
      (entry) => entry.path === owned.path,
    ),
  );
  assert.ok(
    (await independent.customizeSkills()).some(
      (entry) => entry.path === owned.path,
    ),
  );
  await assert.rejects(
    bridge.readSkill(owned.path),
    /not in the offline fixture/,
  );
  assert.deepEqual((await bridge.snapshot()).host, host);
});
