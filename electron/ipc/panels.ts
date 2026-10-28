import { ownsNativeBrowserExecution } from "../browser/execution-owner";
import { z } from "zod";
import { tasksFromTurn } from "../../shared/workflow-model";
import {
  browserColorSchemes,
  browserViewports,
  type BrowserColorScheme,
  type BrowserViewportPreset,
  hostBlocked,
} from "../../shared/browser";
import { parseAllowedSite, preference } from "../../shared/settings-extras";
import { previewOrigin } from "../../shared/preview-origin";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { BrowserService } from "../browser/index";
import type { HostWindow } from "../browser/browser-host";
import { codeGitStatus } from "../git/code-git";
import { workingTreeChanges } from "../git/working-tree";
import { listBranches } from "../git/git-scope";
import { changedImage, workspaceTop } from "../artifacts/changed-image";
import { applySuggestion } from "../git/review-threads";
import {
  conversationWorkspace,
  contextSources,
} from "../workspace/workspace-fs";
import { watchRemoteGeneratedFiles } from "../ssh/remote-workspace-watch";
import { registerBrowserTools } from "../browser/browser-tools-registration";
import { registerBrowserToolHandlers } from "./panels-browser-tools";

/**
 * What the Browser calls need from Electron: the account's Browser service
 * and the system dialogs. `electron/browser/index.ts` supplies them; tests
 * pass stand-ins.
 */
export interface BrowserPanelDeps {
  service(ctx: AppContext): BrowserService | Promise<BrowserService>;
  /** A save dialog for a PNG over `window`; false when cancelled. */
  saveImage(
    window: unknown,
    png: Buffer,
    suggestedName: string,
  ): Promise<boolean>;
  /** An open dialog for one .html/.htm file over `window`. */
  chooseHtmlFile(window: unknown): Promise<string | undefined>;
  saveFile?(window: unknown, bytes: Buffer, name: string): Promise<boolean>;
  /** The system browser. */
  openExternal(url: string): Promise<void>;
}

const electronDeps = (): Promise<BrowserPanelDeps> =>
  import("../browser/index").then((module) => module.electronPanelDeps);

export const conversationIdSchema = z.string().min(1).max(200);
/** A branch name or commit id; git-scope.ts checks them again before use. */
const branchNameSchema = z.string().min(1).max(200);
const diffScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("branch"), base: branchNameSchema.optional() })
    .strict(),
  z
    .object({
      kind: z.literal("uncommitted"),
      base: branchNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      sha: z.string().regex(/^[0-9a-f]{4,64}$/i),
      base: branchNameSchema.optional(),
    })
    .strict(),
]);
export const tabIdSchema = z.string().regex(/^tab-\d{1,9}$/);
const boundsSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    width: z.number().finite().min(0).max(20_000),
    height: z.number().finite().min(0).max(20_000),
  })
  .strict();
const viewportSchema = z.union([
  z.enum(
    browserViewports as unknown as [
      BrowserViewportPreset,
      ...BrowserViewportPreset[],
    ],
  ),
  z
    .object({
      width: z.number().int().min(1).max(10_000),
      height: z.number().int().min(1).max(10_000),
    })
    .strict(),
]);
const colorSchemeSchema = z.enum(
  browserColorSchemes as unknown as [
    BrowserColorScheme,
    ...BrowserColorScheme[],
  ],
);
export const serverNameSchema = z.string().min(1).max(64);
/** Shape only; the dev servers package validates the configuration itself. */
export const launchConfigurationSchema = z
  .object({
    name: serverNameSchema,
    runtimeExecutable: z.string().min(1).max(256),
    runtimeArgs: z.array(z.string().max(4096)).max(64).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    url: z.string().max(2048).optional(),
    cwd: z.string().max(1024).optional(),
    env: z.record(z.string().max(256), z.string().max(8192)).optional(),
  })
  .strict();

/**
 * The Code tool panels. Terminal and background terminal calls are registered
 * from `terminal.ts` and `background-terminals.ts`; the Changes panel's and the
 * Browser panel's calls (R8) are here.
 *
 * A conversation on an SSH host (R9) has its folder there: the Changes panel
 * asks the host's `git` (electron/workspace-fs.ts), and the files its file
 * changes wrote are snapshotted from the host as they complete.
 */
export function registerPanelHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  browserDeps: () => Promise<BrowserPanelDeps> = electronDeps,
) {
  const sources = contextSources(ctx);
  // Read-only view of the conversation's folder for the Changes panel.
  handle(
    "workingTreeChanges",
    (rawConversation: unknown, rawContext: unknown, rawScope: unknown) => {
      const conversation = ctx.store.conversation(
        conversationIdSchema.parse(rawConversation),
      );
      const context = z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .parse(rawContext);
      const scope = diffScopeSchema.optional().parse(rawScope ?? undefined);
      return workingTreeChanges(
        conversation.cwd,
        context,
        ctx.services.workingTree ??
          conversationWorkspace(sources, conversation),
        scope,
      );
    },
  );
  // "Compare against" in the Changes panel's diff scope menu.
  handle("gitBranches", async (rawConversation: unknown) => {
    const conversation = ctx.store.conversation(
      conversationIdSchema.parse(rawConversation),
    );
    if (!conversation.cwd) return [];
    return listBranches(
      (ctx.services.workingTree ?? conversationWorkspace(sources, conversation))
        .git,
      conversation.cwd,
    );
  });
  // View image: an image file's version before or after the change, on
  // this computer only (a folder on a host or in the cloud says none).
  handle(
    "changedImage",
    async (
      rawConversation: unknown,
      rawPath: unknown,
      rawSide: unknown,
      rawScope: unknown,
    ) => {
      const conversation = ctx.store.conversation(
        conversationIdSchema.parse(rawConversation),
      );
      const file = z.string().min(1).max(4096).parse(rawPath);
      const side = z.enum(["before", "after"]).parse(rawSide);
      const scope = diffScopeSchema.optional().parse(rawScope ?? undefined);
      if (
        !conversation.cwd ||
        (conversation.environment && conversation.environment.kind !== "local")
      )
        return null;
      return changedImage(conversation.cwd, file, side, scope);
    },
  );
  // A reviewer's suggested change, written to the file on this computer.
  handle(
    "applyReviewSuggestion",
    async (rawConversation: unknown, raw: unknown) => {
      const conversation = ctx.store.conversation(
        conversationIdSchema.parse(rawConversation),
      );
      const input = z
        .object({
          path: z.string().min(1).max(4096),
          startLine: z.number().int().min(1),
          endLine: z.number().int().min(1),
          original: z.string().max(1_000_000),
          suggestion: z.string().max(1_000_000),
        })
        .strict()
        .parse(raw);
      if (
        !conversation.cwd ||
        (conversation.environment && conversation.environment.kind !== "local")
      )
        return { ok: false, reason: "denied" } as const;
      const top = await workspaceTop(conversation.cwd);
      return top
        ? applySuggestion(top, input)
        : ({ ok: false, reason: "denied" } as const);
    },
  );
  // The branch row's facts, asked of the same host as the Changes panel.
  handle("codeGitStatus", (rawConversation: unknown) => {
    const conversation = ctx.store.conversation(
      conversationIdSchema.parse(rawConversation),
    );
    return codeGitStatus(
      conversation.cwd,
      ctx.services.workingTree ?? conversationWorkspace(sources, conversation),
    );
  });
  // Main's event observers (tests may leave them out).
  if (typeof ctx.onEvent === "function")
    watchRemoteGeneratedFiles({
      ...sources,
      get store() {
        return ctx.store;
      },
      push: (event) => ctx.push(event),
      onEvent: (cb) => ctx.onEvent(cb),
    });
  handle("clearFinishedBackgroundTasks", (raw: unknown) => {
    const ids = z.array(z.string().min(1).max(1000)).max(1000).parse(raw);
    // Workflow and Agent tasks, and background terminals that ended.
    const allowed = new Set(
      ctx.store.conversations.flatMap((c) => [
        ...c.turns.flatMap((t) => tasksFromTurn(t, c).map((task) => task.id)),
        ...ctx.backgroundHistory.finished(c.id).map((item) => item.id),
      ]),
    );
    return ctx.backgroundHistory.clear(
      ids.filter((value) => allowed.has(value)),
    );
  });
  registerBrowserHandlers(handle, ctx, browserDeps);
  // Claude's Browser tools (R8-C): the claudex_browser MCP server per Code
  // thread. Tests of the panel calls pass stand-in deps and skip it, and so
  // does claudex-runner (plain Node, no Browser panel): its web contexts
  // must not open a loopback MCP server per user.
  if (browserDeps === electronDeps && process.versions.electron)
    registerBrowserTools(ctx);
}

function registerBrowserHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  browserDeps: () => Promise<BrowserPanelDeps>,
) {
  let deps: Promise<BrowserPanelDeps> | undefined;
  const loadDeps = () => (deps ??= browserDeps());
  const service = async () => (await loadDeps()).service(ctx);
  const allowedOrigins = () =>
    preference(ctx.store.settings, "browserAllowedSites");
  const saveOrigins = (sites: string[]) => {
    ctx.store.settings = { ...ctx.store.settings, browserAllowedSites: sites };
    ctx.store.flush();
    ctx.settingsChanged();
  };
  handle("getPreviewAllowedOrigins", () =>
    allowedOrigins().map((origin) => ({ origin, builtin: false })),
  );
  handle(
    "addPreviewAllowedOrigin",
    async (raw: unknown, rawSchemeless: unknown) => {
      const value = z.string().max(4096).parse(raw);
      z.boolean().optional().parse(rawSchemeless);
      const result = parseAllowedSite(value, allowedOrigins());
      if ("refusal" in result)
        return result.refusal === "full" ? "blocked" : result.refusal;
      const policy = (await service()).policy();
      if (
        policy.enabled === false ||
        policy.externalSites === false ||
        hostBlocked(new URL(result.site).hostname, policy.blockedDomains ?? [])
      )
        return "org-blocked";
      saveOrigins([...allowedOrigins(), result.site]);
      return "ok";
    },
  );
  handle("removePreviewAllowedOrigin", (raw: unknown) => {
    const origin = previewOrigin(z.string().max(4096).parse(raw));
    const current = allowedOrigins();
    const next = current.filter(
      (entry) => (previewOrigin(entry) ?? entry) !== origin,
    );
    if (!origin || current.length === next.length) return false;
    saveOrigins(next);
    return true;
  });
  handle("clearPreviewAllowedOrigins", () => {
    saveOrigins([]);
    return true;
  });
  const chromeImport = async () => {
    const browserService = await service();
    if (browserService.policy().enabled === false)
      throw new Error("Your administrator has turned off the browser.");
    const instance = await browserService.chromeImport?.();
    if (!instance) throw new Error("expired");
    return instance;
  };
  handle("getChromeImportAvailability", async () => {
    const policy = (await service()).policy();
    const instance = await chromeImport();
    return {
      available:
        policy.enabled !== false &&
        policy.externalSites !== false &&
        (await instance.profiles()).length > 0,
      touchId: instance.touchId(),
    };
  });
  handle("getCoworkChromeImportAvailability", async () => {
    const browserService = await service();
    const policy = browserService.policy();
    if (
      policy.enabled === false ||
      policy.externalSites === false ||
      !browserService.toolsAvailable()
    )
      return { available: false, reason: "gate_off" };
    const instance = await browserService.chromeImport?.();
    if (!instance || !(await instance.profiles()).length)
      return { available: false, reason: "no_chrome" };
    return { available: true, touchId: instance.touchId() };
  });
  handle("clearCoworkBrowserData", async () => {
    const browserService = await service();
    if (browserService.policy().enabled === false) return false;
    try {
      return (await browserService.clearCoworkBrowserData?.()) ?? false;
    } catch {
      return false;
    }
  });
  handle("listChromeImportProfiles", async () =>
    (await chromeImport()).profiles(),
  );
  handle("getChromeImportSharedOffer", async (raw: unknown) => {
    const { id } = await browser(raw);
    return (await chromeImport()).sharedOffer(id);
  });
  handle(
    "acceptChromeImportSharedOffer",
    async (raw: unknown, rawKeep: unknown) => {
      const keep = z.boolean().parse(rawKeep);
      const { id } = await browser(raw);
      return (await chromeImport()).acceptShared(id, keep);
    },
  );
  handle("listChromeImportSites", async (raw: unknown, rawProfile: unknown) => {
    const profile = z.string().min(1).max(200).parse(rawProfile);
    const { id } = await browser(raw);
    return (await chromeImport()).sites(id, profile);
  });
  handle(
    "importChromeLogins",
    async (
      raw: unknown,
      rawTicket: unknown,
      rawRoots: unknown,
      rawKeep: unknown,
    ) => {
      const ticket = z.string().uuid().parse(rawTicket);
      const roots = z
        .array(z.string().min(1).max(253))
        .min(1)
        .max(1000)
        .parse(rawRoots);
      const keep = z.boolean().parse(rawKeep);
      const { id } = await browser(raw);
      return (await chromeImport()).import(id, ticket, roots, keep);
    },
  );
  handle("listImportedChromeLogins", async (raw: unknown) => {
    const { id } = await browser(raw);
    return (await chromeImport()).list(id);
  });
  handle(
    "removeImportedChromeLogins",
    async (raw: unknown, rawRoot: unknown) => {
      const root = z.string().min(1).max(253).parse(rawRoot);
      const { id } = await browser(raw);
      return (await chromeImport()).remove(id, root);
    },
  );
  /** The Browser of a Code conversation that exists; anything else is refused. */
  const codeConversation = (raw: unknown) => {
    const id = conversationIdSchema.parse(raw);
    const conversation = ctx.store.conversations.find((c) => c.id === id);
    if (!conversation) throw new Error("This conversation doesn't exist.");
    if (!ownsNativeBrowserExecution(ctx, id))
      throw new Error(
        "The browser is only in Code sessions or Cowork sessions running on this computer.",
      );
    return id;
  };
  const browser = async (raw: unknown) => {
    const id = codeConversation(raw);
    const browserService = await service();
    // policy.browser.enabled false: no Browser button or panel (R8 design 5.2).
    if (browserService.policy().enabled === false)
      throw new Error("Your administrator has turned off the browser.");
    return { id, service: browserService };
  };
  const callerWindow = () => {
    const window = ctx.callerWindow();
    if (!window) throw new Error("No window to show the browser in.");
    return window as unknown as HostWindow;
  };
  const devServers = async (raw: unknown) => {
    const requested = conversationIdSchema.parse(raw);
    if (
      ctx.store.conversations.find((c) => c.id === requested)?.environment
        ?.kind === "ssh"
    )
      throw new Error("Dev servers aren't available in SSH sessions.");
    const { id, service: browserService } = await browser(raw);
    // Dev servers run in this computer's folders; an SSH session's is on the host.
    const conversation = ctx.store.conversations.find((c) => c.id === id);
    if (conversation?.mode !== "code")
      throw new Error("Dev servers aren't available here.");
    if (conversation?.environment?.kind === "ssh")
      throw new Error("Dev servers aren't available in SSH sessions.");
    const port = browserService.devServers();
    if (!port || browserService.policy().devServers === false)
      throw new Error("Dev servers aren't available here.");
    return { id, port };
  };

  handle("browserState", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    return s.host.state(id);
  });
  handle("browserOpen", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    s.host.show(id, callerWindow());
    return s.host.state(id);
  });
  handle("browserHide", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    s.host.hide(id, callerWindow());
  });
  handle("browserSetBounds", async (raw: unknown, rawBounds: unknown) => {
    const bounds = boundsSchema.parse(rawBounds);
    const { id, service: s } = await browser(raw);
    s.host.show(id, callerWindow(), bounds);
  });
  handle("browserOcclude", async (raw: unknown, rawOn: unknown) => {
    const on = z.boolean().parse(rawOn);
    const { id, service: s } = await browser(raw);
    return s.host.occlude(id, on);
  });
  handle(
    "browserNavigate",
    async (raw: unknown, rawInput: unknown, rawTab: unknown) => {
      const input = z.string().max(8192).parse(rawInput);
      const tabId = tabIdSchema.optional().parse(rawTab);
      const { id, service: s } = await browser(raw);
      return s.host.navigate(id, input, tabId);
    },
  );
  handle("browserBack", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    s.host.back(id);
  });
  handle("browserForward", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    s.host.forward(id);
  });
  handle("browserReload", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    s.host.reload(id);
  });
  handle("browserStop", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    s.host.stop(id);
  });
  handle("browserNewTab", async (raw: unknown, rawUrl: unknown) => {
    const url = z.string().max(8192).optional().parse(rawUrl);
    const { id, service: s } = await browser(raw);
    return s.host.newTab(id, url || undefined);
  });
  handle("browserSelectTab", async (raw: unknown, rawTab: unknown) => {
    const tabId = tabIdSchema.parse(rawTab);
    const { id, service: s } = await browser(raw);
    s.host.selectTab(id, tabId);
  });
  handle("browserCloseTab", async (raw: unknown, rawTab: unknown) => {
    const tabId = tabIdSchema.parse(rawTab);
    const { id, service: s } = await browser(raw);
    s.host.closeTab(id, tabId);
  });
  handle("browserCloseOtherTabs", async (raw: unknown, rawTab: unknown) => {
    const tabId = tabIdSchema.parse(rawTab);
    const { id, service: s } = await browser(raw);
    s.host.closeOtherTabs(id, tabId);
  });
  handle("browserSetViewport", async (raw: unknown, rawViewport: unknown) => {
    const viewport = viewportSchema.parse(rawViewport);
    const { id, service: s } = await browser(raw);
    await s.host.setViewport(id, viewport);
  });
  handle("browserSetColorScheme", async (raw: unknown, rawScheme: unknown) => {
    const scheme = colorSchemeSchema.parse(rawScheme);
    const { id, service: s } = await browser(raw);
    await s.host.setColorScheme(id, scheme);
  });
  handle("browserPickElement", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    return s.host.pickElement(id);
  });
  handle("browserCancelPick", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    s.host.cancelPick(id);
  });
  handle("browserCapture", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    const png = await s.host.capture(id);
    return png ? { pngBase64: png.toString("base64") } : null;
  });
  // Separate model-sized captures and console reads.
  handle("browserConsoleLogs", async (raw: unknown, rawOptions: unknown) => {
    const options = z
      .object({
        onlyErrors: z.boolean().optional(),
        clear: z.boolean().optional(),
      })
      .strict()
      .default({})
      .parse(rawOptions);
    const { id, service: s } = await browser(raw);
    const page = s.host.driver(id);
    const entries = page.driver.console
      .values()
      .filter(
        (entry) =>
          (!options.onlyErrors || entry.level === "error") &&
          (!entry.url ||
            !previewOrigin(entry.url) ||
            previewOrigin(entry.url) === previewOrigin(page.url)),
      )
      .map(({ level, text, time, source }) => ({
        level,
        text,
        timestamp: time,
        source,
      }));
    if (options.clear) page.driver.console.clear();
    return entries;
  });
  handle("browserModelScreenshot", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    const page = s.host.driver(id);
    const revision = page.driver.revision;
    const frame = await page.driver.screenshot();
    const current = s.host.driver(id);
    return current.driver === page.driver &&
      current.tabId === page.tabId &&
      current.url === page.url &&
      current.driver.revision === revision
      ? frame
      : null;
  });
  handle("browserSnapshot", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    const page = s.host.driver(id);
    const revision = page.driver.revision;
    const snapshot = await page.driver.snapshot();
    const current = s.host.driver(id);
    return current.driver === page.driver &&
      current.tabId === page.tabId &&
      current.url === page.url &&
      current.driver.revision === revision
      ? snapshot
      : null;
  });
  handle(
    "browserInspect",
    async (raw: unknown, rawSelector: unknown, rawProperties: unknown) => {
      const selector = z.string().min(1).max(4096).parse(rawSelector);
      const properties = z
        .array(z.string().min(1).max(200))
        .max(100)
        .optional()
        .parse(rawProperties);
      const { id, service: s } = await browser(raw);
      const page = s.host.driver(id);
      const revision = page.driver.revision;
      const info = await page.driver.inspectElement(selector, properties);
      const current = s.host.driver(id);
      if (
        current.driver !== page.driver ||
        current.tabId !== page.tabId ||
        current.url !== page.url ||
        current.driver.revision !== revision
      )
        return null;
      return info ? { found: true, info } : { found: false };
    },
  );
  handle("browserSaveScreenshot", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    const png = await s.host.capture(id);
    if (!png) throw new Error("Open a page to save a screenshot.");
    const window = ctx.callerWindow();
    return (await loadDeps()).saveImage(
      window,
      png,
      screenshotName(s.host.activeUrl(id)),
    );
  });
  handle("browserOpenHtmlFile", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    const file = await (await loadDeps()).chooseHtmlFile(ctx.callerWindow());
    if (!file) return false;
    if (!/\.html?$/i.test(file))
      throw new Error("Choose an HTML file (.html or .htm).");
    const result = s.host.openFile(id, file);
    if (!result.ok) throw new Error(result.message);
    return true;
  });
  handle("browserExportFile", async (raw: unknown) => {
    const { id, service: s } = await browser(raw);
    const file = await s.host.exportFile(id);
    const deps = await loadDeps();
    if (!deps.saveFile) throw new Error("Page couldn’t be saved. Try again.");
    return deps.saveFile(ctx.callerWindow(), file.bytes, file.name);
  });
  registerBrowserToolHandlers({
    browser,
    ctx,
    devServers,
    handle,
    loadDeps,
    service,
  });
}

/** "localhost 5173 screenshot.png" from the page's address. */
export function screenshotName(url: string) {
  let base = "Page";
  try {
    const parsed = new URL(url);
    base = parsed.host || parsed.pathname.split("/").pop() || base;
  } catch {
    // The default name.
  }
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safe || "Page"} screenshot.png`;
}
