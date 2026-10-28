import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoworkOptions } from "../../src/composer/CoworkOptions";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";

const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((value): value is string => !!value && fs.existsSync(value));
const css = (file: string) =>
  fs.readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
const foundation = [
  "styles/00-foundation.css",
  "styles/20-workspace.css",
  "styles/92-reference-pages.css",
  "home/chat-home.css",
].map(css);
const options = css("composer/cowork-options.css"),
  live = css("live-web/composer.css"),
  web = css("styles/95-web.css");
const picker = renderToStaticMarkup(
  h(
    HostContext.Provider,
    { value: webHost },
    h(CoworkOptions, {
      variant: "chat",
      platform: "darwin",
      projects: [],
      setCwd() {},
      onProject() {},
      onCreateProject() {},
      pickFolder: async () => {},
    }),
  ),
);

async function browser() {
  assert.ok(chrome);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b33-phone-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  let socket: WebSocket | undefined;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let attempt = 0; !fs.existsSync(portFile) && attempt < 800; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const [port, endpoint] = fs
      .readFileSync(portFile, "utf8")
      .trim()
      .split("\n");
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () =>
        reject(new Error("Local browser connection failed"));
    });
    let serial = 0;
    const pending = new Map<
      number,
      {
        resolve(value: any): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    };
    const send = (
      method: string,
      params: object = {},
      sessionId?: string,
    ): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Local browser timeout: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket!.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = (method: string, params: object = {}) =>
      send(method, params, sessionId);
    await page("Page.enable");
    await page("Network.enable");
    await page("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
    return {
      async layout({
        width = 390,
        touch = true,
        sheets = [...foundation, options, web, live],
        home = true,
        code = false,
        native = false,
      }: {
        width?: number;
        touch?: boolean;
        sheets?: string[];
        home?: boolean;
        code?: boolean;
        native?: boolean;
      } = {}) {
        await page("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: touch,
        });
        await page("Emulation.setTouchEmulationEnabled", {
          enabled: touch,
          ...(touch ? { maxTouchPoints: 1 } : {}),
        });
        await page("Emulation.setEmulatedMedia", {
          features: [
            { name: "pointer", value: touch ? "coarse" : "fine" },
            { name: "hover", value: touch ? "none" : "hover" },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
        const { frameTree } = await page("Page.getFrameTree");
        const markup = `<html lang="en" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1">${sheets.map((sheet) => `<style>${sheet}</style>`).join("")}</head><body><main class="app ${native ? "" : "web"}"><div class="${home && !code ? "chat-home" : code ? "code-home" : "chat-reply"}"><div class="composer-wrap ${code ? "code-composer" : ""} ${home ? "" : "conversation-composer"}"><div class="composer-chin" data-place="${home ? "home" : "conversation"}"><div class="composer-chin-leading">${picker}</div></div></div></div></main></body></html>`;
        await page("Page.setDocumentContent", {
          frameId: frameTree.frame.id,
          html: markup,
        });
        const evaluate = async (expression: string) =>
          (await page("Runtime.evaluate", { expression, returnByValue: true }))
            .result.value;
        const measured = await evaluate(
          `(()=>{const button=document.querySelector('.cowork-options > button'),row=button.parentElement,s=getComputedStyle(button),r=button.getBoundingClientRect();return {width:r.width,height:r.height,rowHeight:getComputedStyle(row).height,padding:s.paddingInlineStart,coarse:matchMedia('(pointer: coarse)').matches,label:button.querySelector('span').textContent,viewport:innerWidth};})()`,
        );
        const long = await evaluate(
          `(()=>{const button=document.querySelector('.cowork-options > button');button.querySelector('span').textContent='Un projet avec un nom beaucoup plus long';return button.getBoundingClientRect().width;})()`,
        );
        return { ...measured, longWidth: long };
      },
      async close() {
        socket?.close();
        child.kill("SIGTERM");
        await exited;
        fs.rmSync(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    socket?.close();
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

test(
  "actual rendered phone Project keeps the reused 32px touch target in either lazy-sheet order",
  { skip: !chrome },
  async (t) => {
    const page = await browser();
    try {
      for (const sheets of [
        [...foundation, options, web, live],
        [...foundation, live, web, options],
      ]) {
        const result = await page.layout({ sheets });
        assert.equal(result.viewport, 390);
        assert.equal(result.coarse, true);
        assert.equal(result.label, "Project");
        assert.equal(result.height, 32);
        assert.equal(
          result.rowHeight,
          "24px",
          "the target extends beyond the 24px chin row",
        );
        assert.equal(result.padding, "12px");
        assert.ok(
          result.longWidth > result.width + 80,
          "translated labels retain intrinsic width rather than a fixed 80px box",
        );
        t.diagnostic(
          `390px touch Project: ${result.width.toFixed(2)}×${result.height}px with system UI font; longer label grows to ${result.longWidth.toFixed(2)}px`,
        );
      }
    } finally {
      await page.close();
    }
  },
);

test(
  "phone touch override is necessary and keeps desktop, reply, Code and native boundaries",
  { skip: !chrome },
  async () => {
    const page = await browser();
    try {
      const noPhone = await page.layout({
        sheets: [...foundation, options, live],
      });
      assert.equal(
        noPhone.height,
        24,
        "removing 95-web touch treatment restores the old target",
      );
      for (const scenario of [
        { width: 1440, touch: false },
        { width: 390, touch: false },
        { width: 390, touch: true, home: false },
        { width: 390, touch: true, code: true },
        { width: 390, touch: true, native: true },
      ])
        assert.equal(
          (await page.layout(scenario)).height,
          24,
          JSON.stringify(scenario),
        );
    } finally {
      await page.close();
    }
  },
);
