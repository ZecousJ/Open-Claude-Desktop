import { type McpCallContext, type McpCallResult } from "./mcp-server";
import { siteKey } from "./site-permissions";
import { ToolName, parseArgs, ToolError, ok } from "./browser-tool-args";
import {
  untrustedNotice,
  originLabel,
  passwordQuestion,
  pasteQuestion,
  scriptQuestion,
} from "./browser-tool-questions";
import {
  tabLine,
  modifierMask,
  target,
  typesCharacters,
  pastesClipboard,
  devServerLine,
} from "./browser-tool-helpers";
import type { BrowserTools } from "./mcp-tools";

export async function run(
  this: BrowserTools,
  name: ToolName,
  raw: Record<string, unknown>,
  call: McpCallContext,
): Promise<McpCallResult> {
  const id = call.conversationId;
  const service = await this.deps.service();
  this.assertExecution(id, call);
  const host = service.host;
  switch (name) {
    case "tabs_list": {
      parseArgs(name, raw);
      const state = host.state(id);
      return ok(
        state.tabs
          .map((tab) => tabLine(tab, tab.id === state.activeTabId))
          .join("\n") || "No tabs.",
      );
    }
    case "tab_new": {
      const args = parseArgs(name, raw);
      if (!args.url) {
        const tab = host.newTab(id, undefined, true);
        return ok(`Opened a new tab (${tab}).`);
      }
      const url = await this.addressFor(call, args.url);
      this.assertExecution(id, call);
      this.assertNavigation(id, url, call);
      const tab = host.newTab(id, url, true);
      await this.waitForLoad(host, id, tab);
      return ok(this.pageSummary(host, id, tab, "Opened", call));
    }
    case "tab_select": {
      const args = parseArgs(name, raw);
      this.knownTab(host, id, args.tabId);
      host.selectTab(id, args.tabId);
      return ok(`Showing ${args.tabId}.`);
    }
    case "tab_close": {
      const args = parseArgs(name, raw);
      this.knownTab(host, id, args.tabId);
      host.closeTab(id, args.tabId);
      return ok(`Closed ${args.tabId}.`);
    }
    case "navigate":
      return this.navigate(service, call, parseArgs(name, raw));
    case "screenshot": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const shot = await page.driver.screenshot({
        fullPage: args.fullPage,
        ref: args.ref,
      });
      return ok(
        `${untrustedNotice(originLabel(page.url))}\nScreenshot of ${page.url} (${page.tabId}): ${shot.width}×${shot.height} image, ${shot.scale} image pixels per CSS pixel.`,
        { type: "image", data: shot.base64, mimeType: shot.mimeType },
      );
    }
    case "read_page": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const tree = await page.driver.snapshot({
        ref: args.ref,
        interactiveOnly: args.filter === "interactive",
        maxChars: args.maxChars ?? 50_000,
      });
      return ok(
        `${untrustedNotice(originLabel(page.url))}\n${page.url} (${page.tabId})\n\n${tree}`,
      );
    }
    case "find": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const lines = await page.driver.find(args.query);
      return ok(
        `${untrustedNotice(originLabel(page.url))}\n${
          lines.length
            ? lines.join("\n")
            : `Nothing on the page matches "${args.query}".`
        }`,
      );
    }
    case "get_text": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const text = await page.driver.text(args.maxChars ?? 50_000);
      return ok(
        `${untrustedNotice(originLabel(page.url))}\n${page.url} (${page.tabId})\n\n${text}`,
      );
    }
    case "click": {
      const args = parseArgs(name, raw);
      const at = target(args);
      if (!at) throw new ToolError("Give a ref or a coordinate to click.");
      const page = await this.page(service, call, args.tabId);
      const point = await page.driver.click(at, {
        button: args.button,
        clickCount: args.clickCount,
        modifiers: modifierMask(args.modifiers),
      });
      return ok(
        `Clicked ${args.ref ?? "the point"} at (${Math.round(point.x)}, ${Math.round(point.y)}) on ${page.url}.`,
      );
    }
    case "hover": {
      const args = parseArgs(name, raw);
      const at = target(args);
      if (!at) throw new ToolError("Give a ref or a coordinate to hover.");
      const page = await this.page(service, call, args.tabId);
      await page.driver.hover(at);
      return ok(`Moved the pointer over ${args.ref ?? "the point"}.`);
    }
    case "type": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      if (args.ref) await page.driver.click({ ref: args.ref });
      if (args.text && (await page.driver.focusedIsPassword()))
        await this.askEveryTime(call, passwordQuestion(originLabel(page.url)));
      await page.driver.type(args.text);
      return ok(`Typed ${[...args.text].length} characters on ${page.url}.`);
    }
    case "key": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      if (typesCharacters(args.keys) && (await page.driver.focusedIsPassword()))
        await this.askEveryTime(call, passwordQuestion(originLabel(page.url)));
      const site = siteKey(page.url);
      if (
        pastesClipboard(args.keys) &&
        !(site.kind === "web" && site.local) &&
        site.kind !== "blank"
      )
        await this.askEveryTime(call, pasteQuestion(originLabel(page.url)));
      await page.driver.key(args.keys, args.repeat ?? 1);
      return ok(
        `Pressed ${args.keys}${args.repeat && args.repeat > 1 ? ` ×${args.repeat}` : ""}.`,
      );
    }
    case "scroll": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const distance = (args.amount ?? 3) * 100;
      const dx =
        args.direction === "left"
          ? -distance
          : args.direction === "right"
            ? distance
            : 0;
      const dy =
        args.direction === "up"
          ? -distance
          : args.direction === "down"
            ? distance
            : 0;
      await page.driver.scroll(dx, dy, target(args));
      return ok(`Scrolled ${args.direction} ${distance} pixels.`);
    }
    case "form_input": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const kind = await page.driver.fieldKind(args.ref);
      if (kind.password)
        await this.askEveryTime(call, passwordQuestion(originLabel(page.url)));
      const value =
        typeof args.value === "number" ? String(args.value) : args.value;
      await page.driver.setValue(args.ref, value);
      return ok(
        `Set ${args.ref}${kind.password ? "" : ` to ${JSON.stringify(value)}`}.`,
      );
    }
    case "handle_dialog": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      if (!page.state.dialog)
        throw new ToolError("The page isn't asking anything.");
      this.assertExecution(id, call);
      if (this.deps.permissions.routine(id))
        this.assertNavigation(id, page.url, call);
      await host.answerDialog(id, page.tabId, args.accept, args.text);
      if (this.deps.permissions.routine(id))
        this.assertNavigation(
          id,
          service.host.driver(id, page.tabId).url,
          call,
        );
      return ok(args.accept ? "Accepted the dialog." : "Dismissed the dialog.");
    }
    case "console": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const pattern = args.pattern?.toLowerCase();
      const entries = page.driver.console
        .values()
        .filter((entry) => !args.onlyErrors || entry.level === "error")
        .filter(
          (entry) => !pattern || entry.text.toLowerCase().includes(pattern),
        )
        .slice(-(args.limit ?? 50));
      return ok(
        `${untrustedNotice(originLabel(page.url))}\n${
          entries.length
            ? entries
                .map(
                  (entry) =>
                    `[${entry.level}] ${entry.text}${entry.url ? ` (${entry.url})` : ""}`,
                )
                .join("\n")
            : "No console messages."
        }`,
      );
    }
    case "network": {
      const args = parseArgs(name, raw);
      const page = await this.page(service, call, args.tabId);
      const pattern = args.urlPattern?.toLowerCase();
      const entries = page.driver.network
        .values()
        .filter(
          (entry) =>
            !args.onlyFailed ||
            !!entry.error ||
            (entry.status !== undefined && entry.status >= 400),
        )
        .filter(
          (entry) => !pattern || entry.url.toLowerCase().includes(pattern),
        )
        .slice(-(args.limit ?? 50));
      return ok(
        `${untrustedNotice(originLabel(page.url))}\n${
          entries.length
            ? entries
                .map(
                  (entry) =>
                    `${entry.method} ${entry.url} — ${entry.error ?? entry.status ?? "pending"}${entry.type ? ` (${entry.type})` : ""}`,
                )
                .join("\n")
            : "No network requests."
        }`,
      );
    }
    case "resize": {
      const args = parseArgs(name, raw);
      if (this.deps.permissions.routine(id))
        for (const tab of host.state(id).tabs)
          this.assertNavigation(id, tab.url, call);
      await host.setViewport(id, args.viewport);
      return ok(
        typeof args.viewport === "object"
          ? `Pages now show at ${args.viewport.width} × ${args.viewport.height}. They reload.`
          : args.viewport === "mobile"
            ? "Pages now show as a phone (375 wide, touch). They reload."
            : args.viewport === "tablet"
              ? "Pages now show as a tablet (768 wide, touch). They reload."
              : "Pages now show at the panel's width. They reload.",
      );
    }
    case "evaluate": {
      const args = parseArgs(name, raw);
      if (this.deps.policy().allowScript === false)
        throw new ToolError(
          "Your administrator doesn't allow Claudex to run scripts in pages.",
        );
      const page = await this.page(service, call, args.tabId);
      const key = siteKey(page.url);
      if (!(key.kind === "web" && key.local) && key.kind !== "blank")
        await this.askEveryTime(
          call,
          scriptQuestion(originLabel(page.url), args.expression),
        );
      const value = await page.driver.evaluate(args.expression);
      return ok(`${untrustedNotice(originLabel(page.url))}\n${value}`);
    }
    case "preview_list": {
      parseArgs(name, raw);
      const port = this.devServers(service);
      const config = port.launchConfig(id);
      const servers = port.list(id);
      const lines = servers.map(devServerLine);
      if (config.error) lines.push(`launch.json: ${config.error}`);
      if (!servers.length)
        lines.push(
          config.path
            ? `No dev servers in ${config.path}.`
            : "No dev servers are configured. Add them to .claude/launch.json in the project folder.",
        );
      return ok(lines.join("\n"));
    }
    case "preview_start":
      return this.previewStart(service, call, parseArgs(name, raw).name);
    case "preview_stop": {
      const args = parseArgs(name, raw);
      await this.devServers(service).stop(id, args.name);
      return ok(`Stopped ${args.name}.`);
    }
    case "preview_logs": {
      const args = parseArgs(name, raw);
      let lines = await this.devServers(service).logs(
        id,
        args.name,
        args.lines ?? 200,
      );
      if (args.level === "error")
        lines = lines.filter((line) =>
          /error|exception|failed|fatal|panic/i.test(line),
        );
      if (args.search) {
        const needle = args.search.toLowerCase();
        lines = lines.filter((line) => line.toLowerCase().includes(needle));
      }
      return ok(lines.length ? lines.join("\n") : "No matching output.");
    }
  }
}
