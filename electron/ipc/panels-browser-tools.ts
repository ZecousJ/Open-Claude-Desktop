import { linkOpens } from "../../shared/external-links";
import { z } from "zod";
import {
  tabIdSchema,
  conversationIdSchema,
  launchConfigurationSchema,
  serverNameSchema,
} from "./panels";
import type { BrowserService, DevServersPort } from "../browser/index";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { BrowserPanelDeps } from "./panels";

/** What registerBrowserToolHandlers needs from panels.ts. */
export interface RegisterBrowserToolHandlersKit {
  browser: (raw: unknown) => Promise<{ id: string; service: BrowserService }>;
  ctx: AppContext;
  devServers: (raw: unknown) => Promise<{ id: string; port: DevServersPort }>;
  handle: IpcHandle;
  loadDeps: () => Promise<BrowserPanelDeps>;
  service: () => Promise<BrowserService>;
}

export function registerBrowserToolHandlers(
  kit: RegisterBrowserToolHandlersKit,
) {
  const { browser, ctx, devServers, handle, loadDeps, service } = kit;
  handle("browserOpenExternally", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    const url = s.host.activeUrl(id);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Open a page first.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("Only web pages can be opened in your browser.");
    if (!linkOpens(parsed.href, ctx.policy()))
      throw new Error("Your administrator has turned off external links.");
    await (await loadDeps()).openExternal(parsed.href);
  });
  handle(
    "setPreviewLinkRouting",
    async (raw: unknown, rawTab: unknown, rawEnabled: unknown) => {
      const { id, service } = await browser(raw);
      service.host.setPreviewLinkRouting(
        id,
        z.string().min(1).max(100).parse(rawTab),
        z.boolean().parse(rawEnabled),
      );
    },
  );
  handle(
    "browserAnswerDialog",
    async (
      raw: unknown,
      rawTab: unknown,
      rawAccept: unknown,
      rawText: unknown,
    ) => {
      const tabId = tabIdSchema.parse(rawTab);
      const accept = z.boolean().parse(rawAccept);
      const text = z.string().max(10_000).optional().parse(rawText);
      const { id, service: s } = await browser(raw);
      await s.host.answerDialog(id, tabId, accept, text);
    },
  );
  handle("browserClearData", async (raw?: unknown) => {
    // Clearing is always allowed, also after the administrator turned the browser off.
    const id = raw === undefined ? undefined : conversationIdSchema.parse(raw);
    await (await service()).clearBrowsingData(id);
  });
  handle("browserClearPreviewData", async () => {
    await (await service()).clearPreviewData();
  });
  handle("browserShowStartPage", async (raw: unknown) => {
    const { id, service } = await browser(raw);
    service.host.showStartPage(id);
  });
  handle("browserDefaultBrowserName", async () =>
    (await service()).defaultBrowserName(),
  );

  handle("devServersDetect", async (raw: unknown) => {
    const { id, port } = await devServers(raw);
    return port.detect(id);
  });
  handle("devServersSave", async (raw: unknown, rawConfig: unknown) => {
    const config = launchConfigurationSchema.parse(rawConfig);
    const { id, port } = await devServers(raw);
    await port.save(id, config);
  });
  handle("devServersSetAutoVerify", async (raw: unknown, rawOn: unknown) => {
    const on = z.boolean().parse(rawOn);
    const { id, port } = await devServers(raw);
    if (!port.setAutoVerify)
      throw new Error("Auto-verify can't be saved here.");
    await port.setAutoVerify(id, on);
  });
  handle("devServersStart", async (raw: unknown, rawName: unknown) => {
    const name = serverNameSchema.parse(rawName);
    const { id, port } = await devServers(raw);
    return port.start(id, name);
  });
  handle("devServersStop", async (raw: unknown, rawName: unknown) => {
    const name = serverNameSchema.parse(rawName);
    const { id, port } = await devServers(raw);
    await port.stop(id, name);
  });
  handle(
    "devServersLogs",
    async (raw: unknown, rawName: unknown, rawLines: unknown) => {
      const name = serverNameSchema.parse(rawName);
      const lines = z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .parse(rawLines);
      const { id, port } = await devServers(raw);
      return port.logs(id, name, lines);
    },
  );
}
