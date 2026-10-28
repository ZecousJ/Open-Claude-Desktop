import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import type {
  CustomizeSkill,
  SkillContents,
} from "../../shared/collections-api";
import type { McpServerState } from "../../shared/settings-desktop-api";
import type { CustomizePlace } from "../../src/web/customize-route";
import {
  connectors,
  connectorServer,
  directoryConnectors,
} from "../../shared/connectors-catalogue";
import { defaultSettings } from "../../electron/store/store";
import { webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";

test("an explicit native connector identity wins over an earlier same-URL custom server", () => {
  // Use a real supported native identity. The URL is fixture metadata,
  // deliberately shared by a custom server; it is not a vendor endpoint.
  const drive = {
    ...connectors.find((entry) => entry.id === "google-drive")!,
    url: "https://fixture.invalid/drive-mcp",
  };
  const custom: McpServerState = {
    name: "custom-drive",
    url: drive.url,
    state: "ready",
    tools: 0,
  };
  const native: McpServerState = {
    name: "native-drive",
    connectorId: "google-drive",
    state: "ready",
    tools: 0,
  };
  assert.equal(connectorServer(drive, [custom, native]), native);
  assert.equal(connectorServer(drive, [native, custom]), native);
});

test("a different same-name service connector does not inherit observed Notion facts", () => {
  const service: ApprovedDirectoryEntry = {
    id: "different-service-notion",
    kind: "mcp",
    name: "Notion",
    description: "A different organization connector",
    author: "Different publisher",
    url: "https://different.example/mcp",
    added: "2026-10-17",
  };
  const catalogue = directoryConnectors([service]);
  const own = catalogue.find((entry) => entry.directoryId === service.id)!;
  assert.ok(own);
  assert.equal(own.url, service.url);
  for (const key of [
    "longDescription",
    "publisherUrl",
    "supportUrl",
    "privacyPolicyUrl",
    "iconUrl",
    "relatedIds",
    "tools",
    "categories",
  ] as const)
    assert.equal(
      own[key],
      undefined,
      `${key} must not come from a distinct Notion record`,
    );
  assert.ok(
    catalogue.some(
      (entry) =>
        entry.id === "notion" && entry.url === "https://mcp.notion.com/mcp",
    ),
  );
});

test("metadata enrichment for the actual observed Notion URL retains that record's published facts", () => {
  const catalogue = directoryConnectors([
    {
      id: "notion-publication",
      kind: "mcp",
      name: "Notion",
      description: "Approved summary",
      url: "https://mcp.notion.com/mcp",
      added: "2026-10-17",
    },
  ]);
  const own = catalogue.find((entry) => entry.id === "notion")!;
  assert.equal(own.directoryId, "notion-publication");
  assert.equal(own.publisherUrl, "https://notion.com/");
  assert.equal(own.supportUrl, "mailto:developers@makenotion.com");
});

test("switching an installed skill deep link never pairs the new title with old file contents", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const skill = (name: string): CustomizeSkill => ({
    name,
    path: `/fixture/${name}/SKILL.md`,
    description: name,
    scope: "user",
    enabled: true,
    own: true,
  });
  const skills = [skill("Skill A"), skill("Skill B")];
  const contents = (markdown: string): SkillContents => ({
    markdown,
    files: [{ path: "SKILL.md", bytes: markdown.length }],
    truncated: false,
  });
  let finishB!: (value: SkillContents) => void;
  const pendingB = new Promise<SkillContents>((resolve) => {
    finishB = resolve;
  });
  const reads: string[] = [];
  Object.assign(window, {
    desktop: {
      customizeSkills: async () => skills,
      mcpServers: async () => ({ servers: [] }),
      listPlugins: async () => ({
        plugins: [],
        marketplaces: [],
        loadErrors: [],
      }),
      readSkill: async (path: string) => {
        reads.push(path);
        return path === skills[0].path
          ? contents("OLD_SKILL_A_BODY")
          : pendingB;
      },
    },
  });
  const globals = {
    window,
    document,
    location: new URL(
      "https://fixture.test/customize/skills/yours/id/Skill%20A",
    ),
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
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
  let route: CustomizePlace = {
    section: "skills",
    view: "yours",
    detailId: "Skill A",
    detailView: "contents",
  };
  const view = () =>
    createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(CustomizePage, {
        settings: defaultSettings,
        route,
        onRouteChange() {},
        onUseSkill() {},
        onOpenSettings() {},
        onConfirmRemove() {},
        onError(error: unknown) {
          throw error;
        },
      }),
    );
  try {
    await act(async () => root.render(view()));
    assert.match(
      document.querySelector(".skill-detail-markdown")?.textContent ?? "",
      /OLD_SKILL_A_BODY/,
    );
    route = {
      section: "skills",
      view: "yours",
      detailId: "Skill B",
      detailView: "contents",
    };
    await act(async () => root.render(view()));
    assert.ok(
      reads.includes(skills[1].path),
      "the B load really starts and remains pending",
    );
    assert.match(
      document.querySelector(".installed-skill-page h2")?.textContent ?? "",
      /Skill B/,
    );
    assert.doesNotMatch(
      document.querySelector(".skill-detail-markdown")?.textContent ?? "",
      /OLD_SKILL_A_BODY/,
    );
    await act(async () => {
      finishB(contents("NEW_SKILL_B_BODY"));
      await pendingB;
    });
    assert.match(
      document.querySelector(".skill-detail-markdown")?.textContent ?? "",
      /NEW_SKILL_B_BODY/,
    );
  } finally {
    await act(async () => {
      finishB(contents("NEW_SKILL_B_BODY"));
      await pendingB;
    });
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

test("runtime translation preserves connector data in visible and accessible names while translating permission UI", () => {
  // Isolate the document translator's global observer and locale store in a
  // child process. Render the real detail + ToolPermissions, then translate
  // the actual DOM; a static attribute check would miss the data corruption.
  const script = `
    const {parseHTML}=await import('linkedom');
    const {window,document}=parseHTML('<html><body></body></html>');
    Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1}});
    const {createElement}=await import('react');
    const {renderToStaticMarkup}=await import('react-dom/server');
    const {CustomizeConnectorDetail}=await import('./src/settings/directory/CustomizeConnectorDetail.tsx');
    const {setLocale}=await import('./src/i18n/index.ts');
    const {startDomTranslation}=await import('./src/i18n/dom.ts');
    const noop=()=>{};
    const entry={id:'fixture',name:'Search',description:'Settings',byline:'by Fixture',type:'custom',topic:'',icon:'server',url:'https://fixture.invalid/mcp'};
    const server={name:'Search',state:'ready',tools:1,toolList:[{name:'Search',description:'Settings',enabled:true}]};
    document.body.innerHTML=renderToStaticMarkup(createElement(CustomizeConnectorDetail,{entry,server,editable:true,onBack:noop,onConnect:async()=>{},onSet:noop,onError:noop,remoteIcons:false}));
    await setLocale('zh-CN');
    startDomTranslation();
    const accessibleName=element=>{
      const ids=element.getAttribute('aria-labelledby')?.trim().split(/\\s+/);
      if(ids?.some(id=>!document.getElementById(id))) throw new Error('Broken aria-labelledby reference');
      return ids?.map(id=>document.getElementById(id).textContent).join(' ') ?? element.getAttribute('aria-label');
    };
    const permissionButtons=[...document.querySelectorAll('.tool-permission [role="radio"]')];
    console.log(JSON.stringify({title:document.querySelector('h1').textContent,body:document.querySelector('.connector-published-description').textContent,toolName:document.querySelector('.tool-permissions li strong').textContent,toolDescription:document.querySelector('.tool-permissions li div > span').textContent,allToolsLabel:accessibleName(document.querySelector('.tool-permissions-all')),toolsListLabel:accessibleName(document.querySelector('.tool-permissions ul')),toolPermissionLabel:accessibleName(document.querySelector('.tool-permission')),permissionButtons:permissionButtons.map(accessibleName)}));
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
  const {
    allToolsLabel,
    toolsListLabel,
    toolPermissionLabel,
    permissionButtons,
    ...visible
  } = result;
  assert.deepEqual(visible, {
    title: "Search",
    body: "Settings",
    toolName: "Search",
    toolDescription: "Settings",
  });
  for (const name of [allToolsLabel, toolsListLabel, toolPermissionLabel]) {
    assert.match(
      name,
      /Search/,
      "accessible name retains the literal user-provided server/tool name",
    );
    assert.doesNotMatch(
      name,
      /搜索/,
      "the user's Search name is not translated as UI",
    );
  }
  assert.deepEqual(
    permissionButtons.slice(0, 2),
    ["始终允许", "需要批准"],
    "permission UI remains translated",
  );
});

test("runtime translation preserves installed skill names and descriptions in their actual detail page", () => {
  const script = `
    const {parseHTML}=await import('linkedom');
    const {window,document}=parseHTML('<html><body></body></html>');
    Object.assign(globalThis,{window,document,MutationObserver:window.MutationObserver,Node:window.Node,HTMLElement:window.HTMLElement,NodeFilter:{SHOW_TEXT:4,SHOW_ELEMENT:1}});
    const {createElement}=await import('react');
    const {renderToStaticMarkup}=await import('react-dom/server');
    const {InstalledSkillPage}=await import('./src/collections/customize/InstalledSkillPage.tsx');
    const {setLocale}=await import('./src/i18n/index.ts');
    const {startDomTranslation}=await import('./src/i18n/dom.ts');
    const noop=()=>{};
    const skill={name:'Settings',description:'Search',path:'/fixture/SKILL.md',scope:'user',enabled:true,own:true};
    document.body.innerHTML=renderToStaticMarkup(createElement(InstalledSkillPage,{skill,contents:undefined,error:'',onReload:noop,onBack:noop,onTry:noop,onToggle:async()=>{},onRemove:noop,view:'overview',onViewChange:noop,links:{back:'/customize/skills/yours',overview:'/customize/skills/yours/id/Settings',contents:'/customize/skills/yours/id/Settings/contents'}}));
    await setLocale('zh-CN');
    startDomTranslation();
    const page=document.querySelector('.installed-skill-page');
    const ids=page.getAttribute('aria-labelledby')?.trim().split(/\\s+/);
    if(ids?.some(id=>!document.getElementById(id))) throw new Error('Broken aria-labelledby reference');
    const accessibleName=page.getAttribute('aria-label') ?? ids?.map(id=>document.getElementById(id).textContent).join(' ');
    console.log(JSON.stringify({title:page.querySelector('h2').textContent,label:accessibleName,description:page.querySelector('.installed-skill-overview p').textContent}));
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
  assert.deepEqual(result, {
    title: "Settings",
    label: "Settings",
    description: "Search",
  });
});
