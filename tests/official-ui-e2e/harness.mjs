/**
 * End-to-end harness for the official-interface client (docs/official-ui-client.md).
 *
 * One client, one account session: the built app starts on the `Claudex Test`
 * profile in e2e mode (CLAUDEX_OFFICIAL_UI_E2E=1: windows transparent,
 * click-through and unfocusable, no Dock icon, and a signed-out start exits
 * instead of showing sign-in). Parallel workers each get their own official
 * window in that client (`/__debug/open-window`), so no session is ever
 * copied. Cases drive a window the way a person does (clicks, typing, file
 * inputs) through `/__debug/eval` and check what it shows.
 *
 * Needs `node scripts/build.mjs` and the assembled bundle
 * (`node scripts/build-official-ui.mjs`). Real sends go to the test account's
 * model service; prompts are kept tiny.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const profile =
  process.env.CLAUDEX_E2E_PROFILE ??
  path.join(os.homedir(), "Library/Application Support/Claudex Test");
const pageHelpers = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "page-helpers.js"),
  "utf8",
);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The app process. */
export class Client {
  constructor(logFile) {
    this.logFile = logFile;
    this.origin = "";
    this.cookie = "";
  }

  /** Starts a test client without terminating existing Electron applications. */
  static async launch({ logDir, entrypoint } = {}) {
    const packagedExecutable = process.env.CLAUDEX_E2E_EXECUTABLE;
    if (process.platform === "darwin" && packagedExecutable) {
      const bundleContents = /^(.*\.app\/Contents)\/MacOS\/[^/]+$/.exec(
        path.resolve(root, packagedExecutable),
      )?.[1];
      if (bundleContents) {
        const bundleId = execFileSync(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            "Print :CFBundleIdentifier",
            path.join(bundleContents, "Info.plist"),
          ],
          { encoding: "utf8" },
        ).trim();
        if (bundleId === packageJson.build.appId) {
          throw new Error(
            `CLAUDEX_E2E_EXECUTABLE uses the production bundle ID ${bundleId}. Use a packaged app with a separate fixture bundle ID (CFBundleIdentifier).`,
          );
        }
      }
    }
    logDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "claudex-e2e-"));
    const listener = net.createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const logFile = path.join(logDir, "client.log");
    const out = fs.openSync(logFile, "w");
    const child = spawn(
      packagedExecutable ?? path.join(root, "node_modules/.bin/electron"),
      [
        ...(packagedExecutable ? [] : [entrypoint ?? "."]),
        `--remote-debugging-port=${port}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CLAUDEX_OFFICIAL_UI_DEBUG: "1",
          CLAUDEX_OFFICIAL_UI_E2E: "1",
          CLAUDEX_DATA_DIR: profile,
        },
        stdio: ["ignore", out, out],
        detached: true,
      },
    );
    child.unref();
    let exited = null;
    child.on("exit", (code) => (exited = code));
    const client = new Client(logFile);
    client.child = child;
    for (let i = 0; i < 120 && exited === null; i++) {
      const text = fs.readFileSync(logFile, "utf8");
      const line = text.split("\n").find((l) => l.includes("debug origin"));
      if (line) {
        const m = /debug origin (\S+)/.exec(line);
        client.origin = m[1];
        break;
      }
      if (text.includes("e2e: no signed-in account")) break;
      await sleep(500);
    }
    if (!client.origin) {
      const text = fs.readFileSync(logFile, "utf8");
      await client.stop();
      throw new Error(
        text.includes("e2e: no signed-in account")
          ? "The test profile is signed out: sign in to it once (CLAUDEX_DATA_DIR=<profile> npx electron .), then run again."
          : `The client did not start; see ${logFile}`,
      );
    }
    let target;
    for (let attempt = 0; attempt < 100 && !target; attempt++) {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      target = targets.find((item) => item.url.startsWith(client.origin));
      if (!target) await sleep(100);
    }
    if (!target) {
      child.kill();
      throw Error("The isolated client did not open its account window.");
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let requestId = 0;
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++requestId;
        const listener = (event) => {
          const response = JSON.parse(event.data);
          if (response.id !== id) return;
          socket.removeEventListener("message", listener);
          response.error
            ? reject(Error(response.error.message))
            : resolve(response.result);
        };
        socket.addEventListener("message", listener);
        socket.send(JSON.stringify({ id, method, params }));
      });
    let cookie;
    for (let attempt = 0; attempt < 100 && !cookie; attempt++) {
      const result = await call("Network.getCookies", {
        urls: [client.origin],
      });
      cookie = result.cookies.find(
        (item) => item.name === "claudex_official_ui",
      );
      if (!cookie) await sleep(100);
    }
    socket.close();
    if (!cookie) {
      child.kill();
      throw Error("The isolated client did not establish its session cookie.");
    }
    client.cookie = `${cookie.name}=${cookie.value}`;
    const main = client.page(0);
    await main.waitFor(
      "document.readyState === 'complete' && !!document.querySelector('main')",
      60000,
      250,
    );
    return client;
  }

  /** A window of the app: 0 is the main one; `openPage()` makes more. */
  page(windowId) {
    return new Page(this, windowId);
  }

  async openPage() {
    const response = await fetch(`${this.origin}/__debug/open-window`, {
      method: "POST",
      headers: { Cookie: this.cookie },
    });
    const { id } = await response.json();
    const page = new Page(this, id);
    await page.waitFor(
      "document.readyState === 'complete' && !!document.querySelector('main')",
      60000,
      250,
    );
    return page;
  }

  async stop() {
    if (!this.child?.pid) return;
    const group = -this.child.pid;
    try {
      process.kill(group, "SIGTERM");
    } catch {
      return;
    }
    // Let Electron release its profile lock; only this test's process group
    // is terminated if it does not exit cleanly.
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      try {
        process.kill(group, 0);
      } catch {
        return;
      }
    }
    try {
      process.kill(group, "SIGKILL");
    } catch {}
  }

  /** Exercise real app.quit; forced cleanup is never counted as a successful quit. */
  async quit(timeoutMs = 25000) {
    const response = await fetch(this.origin + "/__debug/quit", {
      method: "POST",
      headers: { Cookie: this.cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 204)
      throw Error("Normal quit request failed: " + response.status);
    const started = Date.now();
    while (
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      Date.now() - started < timeoutMs
    )
      await sleep(100);
    if (this.child.exitCode !== 0)
      throw Error("Client did not exit normally within " + timeoutMs + " ms");
    return Date.now() - started;
  }

  logMark() {
    return fs.statSync(this.logFile).size;
  }
  logSince(mark) {
    const fd = fs.openSync(this.logFile, "r");
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.max(0, size - mark));
    fs.readSync(fd, buffer, 0, buffer.length, mark);
    fs.closeSync(fd);
    return buffer
      .toString("utf8")
      .split("\n")
      .filter((l) => l && !/^\s+at /.test(l));
  }
  /** Adapter refusals and unanswered calls since `mark`. */
  gapsSince(mark) {
    return this.logSince(mark).filter((l) =>
      /action refused|no adapter for|Native host adapter is not configured|request failed/.test(
        l,
      ),
    );
  }
}

/** One official window, driven by the cases (they call it `client`). */
export class Page {
  constructor(client, windowId) {
    this.client = client;
    this.windowId = windowId;
  }
  get logFile() {
    return this.client.logFile;
  }
  logMark() {
    return this.client.logMark();
  }
  logSince(mark) {
    return this.client.logSince(mark);
  }
  gapsSince(mark) {
    return this.client.gapsSince(mark);
  }

  /** Runs `script` (an expression, may be a promise) in the page, helpers under `window.__e2e`; gives up after `timeoutMs` (a navigation can leave the call unanswered). */
  async eval(script, timeoutMs = 150000) {
    const body = `(async () => { if (!window.__e2e) { ${pageHelpers} } return await (${script}); })()`;
    const query = this.windowId ? `?window=${this.windowId}` : "";
    const response = await fetch(`${this.client.origin}/__debug/eval${query}`, {
      method: "POST",
      headers: { Cookie: this.client.cookie },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json();
    if (json.error) throw new Error(`page: ${json.error}`);
    return json.value;
  }

  async waitFor(expression, timeoutMs = 20000, intervalMs = 400) {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
      try {
        last = await this.eval(expression, 20000);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `Timed out waiting for ${expression} (last: ${JSON.stringify(last)})`,
    );
  }

  /** A native click for controls that require a trusted pointer event. */
  async click(selector) {
    const point = await this.waitFor(
      `(async () => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || !__e2e.visible(e) || e.disabled || e.getAttribute('aria-disabled')==='true') return null; e.scrollIntoView({block:'center'}); const first=e.getBoundingClientRect(); await new Promise(r=>setTimeout(r,50)); const r = e.getBoundingClientRect(); if(Math.abs(first.x-r.x)>0.5||Math.abs(first.y-r.y)>0.5)return null; const x=r.x+r.width/2,y=r.y+r.height/2; if(!e.contains(document.elementFromPoint(x,y)))return null; return {x,y}; })()`,
    );
    const query = new URLSearchParams({
      x: String(point.x),
      y: String(point.y),
      ...(this.windowId ? { window: String(this.windowId) } : {}),
    });
    const answer = await fetch(`${this.client.origin}/__debug/click?${query}`, {
      method: "POST",
      headers: { Cookie: this.client.cookie },
    });
    if (!answer.ok) throw Error(`Click failed: ${answer.status}`);
  }

  /** Loads a page route in this window (the main process waits for the load). */
  async goto(route) {
    const query = new URLSearchParams({
      route,
      ...(this.windowId ? { window: String(this.windowId) } : {}),
    });
    const response = await fetch(
      `${this.client.origin}/__debug/navigate?${query}`,
      {
        method: "POST",
        headers: { Cookie: this.client.cookie },
        signal: AbortSignal.timeout(60000),
      },
    );
    const json = await response.json();
    if (json.error) throw new Error(`navigate ${route}: ${json.error}`);
    // The app renders after load: wait for its frame to appear.
    await this.waitFor(
      "document.readyState === 'complete' && !!(document.querySelector('main') || document.querySelector('[data-cds]'))",
      30000,
      200,
    );
    await sleep(400);
  }

  /** Calls the API adapter from inside the page (same cookie and origin as the page). */
  api(pathname, init = {}) {
    return this.eval(
      `fetch(${JSON.stringify(pathname)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, body: await r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }) }))`,
    );
  }
}

export class AssertionError extends Error {}
export function expect(condition, message) {
  if (!condition) throw new AssertionError(message);
}
