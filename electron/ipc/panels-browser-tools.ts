import { linkOpens } from "../../shared/external-links";
import { launchPort } from "../../shared/launch-config";
import { isLocalDevHost, isPrivateNetworkHost, pageOrigin } from "../../shared/browser";
import { navigationAllowed } from "../browser/navigation-guard";
import { officialPreviewTabLimit } from "../browser/browser-host-support";
import fs from "node:fs/promises";
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
import {
  detectServerCandidates,
  detectServerCandidatesWithAgent,
  selectedServerCandidate,
} from "../browser/dev-server-candidates";
import {
  CompletionUnavailableError,
  gatewayCompleter,
} from "../memory/completion";

/** What registerBrowserToolHandlers needs from panels.ts. */
export interface RegisterBrowserToolHandlersKit {
  browser: (raw: unknown) => Promise<{ id: string; service: BrowserService }>;
  ctx: AppContext;
  devServers: (raw: unknown, runningOnly?: boolean) => Promise<{ id: string; port: DevServersPort }>;
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
  const externalAddress = (url: string) => {
    if (!linkOpens(url, ctx.policy())) return null;
    const parsed = new URL(url);
    if (!isLocalDevHost(parsed.hostname)) {
      parsed.search = "";
      parsed.hash = "";
    }
    parsed.username = "";
    parsed.password = "";
    return linkOpens(parsed.href, ctx.policy()) ? parsed.href : null;
  };
  handle("officialOpenBrowserPreviewExternally", async (raw: unknown, rawTab: unknown) => {
    const tab = tabIdSchema.optional().parse(rawTab);
    const { id, service } = await browser(raw);
    const session = service.host.sessions.get(id);
    const url = session?.tabs.find((row) => row.id === (tab ?? session.activeTabId))?.state.url;
    const address = url && externalAddress(url);
    if (!address) return false;
    await (await loadDeps()).openExternal(address);
    return true;
  });
  handle("officialOpenRoutedBrowserLink", async (rawPreview: unknown, rawUrl: unknown) => {
    const previewId = z.string().max(250).parse(rawPreview);
    const address = externalAddress(z.string().max(8192).parse(rawUrl));
    const window = ctx.callerWindow();
    if (!address || !window || window.isDestroyed()) return false;
    const [{ openExternal }, { previewLinkRouter }] = await Promise.all([
      loadDeps(),
      import("../artifacts/preview-link-routing"),
    ]);
    return previewLinkRouter(ctx).request(address, {
      window,
      notify: (requestId, url) => ctx.push({
        type: "official-preview-link-confirm",
        windowId: window.id,
        previewId,
        requestId,
        url,
      }),
      open: openExternal,
    });
  });
  handle("officialFocusOrOpenBrowserTab", async (raw: unknown, rawUrl: unknown, rawSource: unknown) => {
    const input = z.string().max(8192).parse(rawUrl);
    const source = z.enum(["server", "launch", "external", "clicked"]).parse(rawSource);
    if (!/^https?:\/\//i.test(input)) return null;
    const { id, service } = await browser(raw);
    const session = service.host.session(id);
    if (!navigationAllowed(input, service.host.guardOptions(session)).allow) return null;
    const url = new URL(input);
    const local = isLocalDevHost(url.hostname);
    if (source === "launch" && !local && service.policy().externalSites === false) return null;
    if (source === "server" && !local) return null;
    if (source !== "server" && isPrivateNetworkHost(url.hostname)) return null;
    if (source === "external" && local && !service.host.deps.devServers?.(id)?.servers.some(
      (server) => server.status === "running" && server.url && new URL(server.url).port === url.port,
    )) return null;
    const existing = session.tabs.find((tab) => tab.state.url === url.href) ??
      session.tabs.find((tab) => pageOrigin(tab.state.url) === url.origin) ??
      (source === "launch" ? session.tabs.find((tab) => !tab.state.url || tab.state.url === "about:blank") : undefined);
    if (!existing)
      return session.tabs.length < officialPreviewTabLimit
        ? service.host.newTab(id, url.href)
        : null;
    const retry = !existing.state.url || existing.state.url === "about:blank" || existing.state.error || existing.state.crashed;
    if ((source === "launch" && retry) ||
        ((source === "clicked" || source === "external") && (retry || existing.state.url !== url.href))) {
      if (!service.host.navigate(id, url.href, existing.id).ok) return null;
    }
    service.host.selectTab(id, existing.id);
    return existing.id;
  });
  handle("officialSetBrowserPreviewLinkRouting", async (raw: unknown, rawEnabled: unknown) => {
    const enabled = z.boolean().parse(rawEnabled);
    const { id, service } = await browser(raw);
    service.host.session(id).routePreviewLinks = enabled;
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
  handle("officialClearPreviewBrowsingData", async (raw: unknown) => {
    const id = conversationIdSchema.parse(raw);
    return (await service()).clearBrowsingData(id);
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
  handle("officialConfiguredDevServers", async (raw: unknown) => {
    const { id, port } = await devServers(raw);
    return port.configurations(id).map((entry) => ({
      name: entry.name,
      port: launchPort(entry),
    }));
  });
  const candidateProject = async (raw: unknown) => {
    const store = ctx.store;
    const activation = ctx.accountActivationIdentity;
    const { id, port } = await devServers(raw);
    const conversation = store.conversations.find((item) => item.id === id);
    const cwd = conversation?.cwd;
    if (!cwd || conversation.cloudHosted ||
        (conversation.environment?.kind ?? "local") !== "local")
      throw new Error("Dev server detection requires a local Code folder.");
    ctx.services?.workspaceTrust?.assert({ mode: "code", cwd });
    const root = await fs.realpath(cwd);
    const current = () => {
      if (ctx.accountRetiring || ctx.accountActivationIdentity !== activation || ctx.store !== store)
        return undefined;
      return store.conversations.find((item) => item.id === id && item.cwd === cwd &&
        !item.cloudHosted && (item.environment?.kind ?? "local") === "local");
    };
    if (!current()) throw new Error("This Code folder is no longer available.");
    return { id, port, conversation, root, current, store };
  };
  handle("officialDevServerCandidates", async (raw: unknown) => {
    const { root } = await candidateProject(raw);
    return detectServerCandidates(root);
  });
  handle("officialDetectDevServersWithAgent", async (raw: unknown) => {
    const project = await candidateProject(raw);
    const engine = ctx.engine;
    const timeout = AbortSignal.timeout(90_000);
    const controller = new AbortController();
    const signal = AbortSignal.any([timeout, controller.signal]);
    const off = ctx.onAccountDeactivating?.(() => controller.abort());
    const { providerId, model } = project.conversation;
    const current = () => {
      const conversation = project.current();
      return conversation?.providerId === providerId && conversation.model === model && ctx.engine === engine;
    };
    const complete = gatewayCompleter(async () => {
      if (!current()) return undefined;
      const provider = project.store.settings.providers.find((item) => item.id === providerId);
      if (!provider || !model || (model !== provider.model && !provider.models.includes(model)))
        return undefined;
      if (!engine.gatewayEndpoint() || engine.providerId !== providerId)
        await engine.ensure(provider, {
          interactive: false,
          current: () => current() && !signal.aborted,
        });
      if (!current() || engine.providerId !== providerId) return undefined;
      const endpoint = engine.gatewayEndpoint();
      return endpoint ? { ...endpoint, model } : undefined;
    });
    try {
      const result = await detectServerCandidatesWithAgent(project.root, complete, signal);
      if (!current()) return { ok: false, candidates: [], reason: "cancelled" };
      return result;
    } catch (error) {
      let reason = "query-failed";
      if (timeout.aborted) reason = "no-result";
      else if (controller.signal.aborted) reason = "cancelled";
      else if (error instanceof CompletionUnavailableError) reason = "binary-not-ready";
      return { ok: false, candidates: [], reason };
    } finally {
      off?.();
    }
  });
  handle("officialAddDevServerCandidate", async (raw: unknown, candidate: unknown) => {
    const { id, port, root, current } = await candidateProject(raw);
    const selection = await selectedServerCandidate(root, candidate);
    if (!selection.ok) return selection;
    if (!current()) return { ok: false, reason: "write-failed" };
    const added = await port.save(id, selection.config, true);
    return added === true ? { ok: true }
      : { ok: false, reason: added === false ? "name-exists" : "write-failed" };
  });
  handle("devServersSave", async (raw: unknown, rawConfig: unknown, rawAddOnly?: unknown) => {
    const config = launchConfigurationSchema.parse(rawConfig);
    const addOnly = z.literal(true).optional().parse(rawAddOnly);
    const { id, port } = await devServers(raw);
    const saved = await port.save(id, config, addOnly);
    if (addOnly) return saved;
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
    const { id, port } = await devServers(raw, true);
    await port.stop(id, name);
  });
  handle("officialDevServerLogs", async (raw: unknown, rawName: unknown) => {
    const name = serverNameSchema.parse(rawName);
    const { id, port } = await devServers(raw, true);
    if (!port.logEntries)
      throw Error("Structured server logs are not available.");
    return port.logEntries(id, name, 500);
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
      const { id, port } = await devServers(raw, true);
      return port.logs(id, name, lines);
    },
  );
}
