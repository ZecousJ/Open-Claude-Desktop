import { previewTabOrigin, viewportFrame, type BrowserNavigateResult, type BrowserState } from "../../../shared/browser";
import type { ImportedChromeLogin } from "../../../shared/chrome-import";
import { isLocalHostname } from "../../../shared/launch-config";
import { hasLocalBrowserExecution, hasOffHostCodeBrowser } from "../../../shared/browser-execution-eligibility";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** Translate the official preview contract to Claudex's real sandboxed Browser. */
export function registerLaunch(
  host: NativeHost,
  focusCodeFiles?: (id?: string | null) => void,
  autoOpenFiles = () => false,
  resetChromeImportPrompt?: () => Promise<void>,
) {
  const { ctx } = host;
  const callers = new AsyncLocalStorage<typeof host.window>();
  const previews = new Map<
    string,
    {
      sessionId: string;
      cwd: string;
      name: string;
      html?: string;
      window?: typeof host.window;
      publicId?: string;
      publishedVersion?: number;
    }
  >();
  const restoring = new Map<string, Promise<void>>();
  const draftStarts = new Map<string, Promise<void>>();
  const previewStarts = new Map<string, Promise<string>>();
  let focusedSessions = new WeakMap<NonNullable<typeof host.window>, string>();
  let hiddenSessions = new WeakMap<NonNullable<typeof host.window>, string>();
  const pendingLinkRouting = new Set<string>();
  const cleanupCalls = new Set(["hidePreview", "destroyPreview", "stopServer", "setPreviewLinkRouting", "setPreviewPaneMounted"]);
  const servers = host.store<{
    serverId: string;
    name: string;
    cwd: string;
    sessionId: string;
    previewId: string;
    tabId?: string;
    externalUrl?: string;
    status: "starting" | "running" | "error";
    port: number;
    startedAt: string;
  }[]>("Launch", "activeServers", []);
  const scope = sessionAccountScope(ctx, () => {
    previews.clear();
    restoring.clear();
    draftStarts.clear();
    previewStarts.clear();
    focusedSessions = new WeakMap();
    hiddenSessions = new WeakMap();
    pendingLinkRouting.clear();
    servers.set([]);
  });
  const call = (method: string, ...args: unknown[]) =>
    scope.guard(async () => {
      if (!scope.sync().owner || ctx.isCurrent?.() === false) throw Error("The preview account is no longer active.");
      const result = await ctx.localCall!(method, ...args);
      if (ctx.isCurrent?.() === false) throw Error("The preview adapter was retired.");
      return result;
    });
  const on = (name: string, fn: (...args: any[]) => unknown) =>
    host.on(`Launch.${name}`, (...args) =>
      callers.run(host.caller ?? host.window, () =>
        scope.run(async () => {
          if (!scope.sync().owner || ctx.isCurrent?.() === false) throw Error("The preview account is no longer active.");
          if (
            typeof args[0] === "string" &&
            args[0].startsWith("preview-landing-window-")
          )
            throw Error(
              "Internal preview identities cannot be supplied by a renderer.",
            );
          if (args[0] === "preview-landing") {
            const window = callers.getStore();
            if (!window) throw Error("No preview window.");
            const key = `preview-landing-window-${window.id}`;
            if (
              !previews.has(key) &&
              !cleanupCalls.has(name)
            ) {
              let pending = draftStarts.get(key);
              if (!pending) {
                pending = (async () => {
                  const result = (await call(
                    "officialDraftBrowserStart",
                    name === "openPreviewTab" ? args[1] : undefined,
                  )) as { ownerId: string; cwd: string; state: BrowserState };
                  if (window.isDestroyed())
                    throw Error("The preview window closed during startup.");
                  const entry = {
                    sessionId: result.ownerId,
                    cwd: result.cwd,
                    name: "Browser",
                    window,
                    publicId: "preview-landing",
                  };
                  previews.set(key, entry);
                  if (pendingLinkRouting.delete(key))
                    await call("officialSetBrowserPreviewLinkRouting", entry.sessionId, true);
                  window.once("closed", () => {
                    if (previews.get(key) === entry) previews.delete(key);
                  });
                })();
                draftStarts.set(key, pending);
              }
              try {
                await pending;
              } finally {
                if (draftStarts.get(key) === pending) draftStarts.delete(key);
              }
            }
            args[0] = key;
          }
          if (
            typeof args[0] === "string" &&
            /^(?:preview-local_|html-preview-)/.test(args[0]) &&
            !cleanupCalls.has(name)
          )
            await restore(args[0]);
          const result = await fn(...args);
          if (!scope.sync().owner || ctx.isCurrent?.() === false) throw Error("The preview account is no longer active.");
          return result;
        }),
      ),
    );
  const savedFile = () => {
    const base = ctx.stateDirectory?.(),
      owner = ctx.account?.()?.id;
    return base && owner
      ? path.join(
          base,
          "official-ui",
          "native-accounts",
          createHash("sha256").update(owner).digest("hex"),
          "previews.json",
        )
      : undefined;
  };
  const saved = (): Record<
    string,
    { sessionId: string; cwd: string; name: string; html?: string }
  > => {
    const file = savedFile();
    if (!file) return {};
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return data.version === 1 &&
        data.previews &&
        typeof data.previews === "object"
        ? data.previews
        : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  const persist = (
    id: string,
    value?: { sessionId: string; cwd: string; name: string; html?: string },
  ) => {
    scope.sync();
    if (id.startsWith("preview-landing-window-")) return;
    const file = savedFile();
    if (!file) return;
    const data = saved();
    if (value) data[id] = value;
    else delete data[id];
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, previews: data }), {
        mode: 0o600,
      });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };
  const restore = async (id: string) => {
    scope.sync();
    if (previews.has(id)) return;
    const entry = saved()[id];
    if (!entry) return;
    if (
      typeof entry.sessionId !== "string" ||
      typeof entry.cwd !== "string" ||
      typeof entry.name !== "string" ||
      (entry.html !== undefined && typeof entry.html !== "string")
    )
      throw Error("Invalid saved preview descriptor.");
    const expected = entry.html
      ? `html-preview-${entry.sessionId}`
      : `preview-local_${entry.sessionId}`;
    if (id !== expected) throw Error("Invalid saved preview identity.");
    let pending = restoring.get(id);
    if (!pending) {
      pending = start(entry.cwd, `local_${entry.sessionId}`, entry.html).then(
        () => {},
      );
      restoring.set(id, pending);
    }
    try {
      await pending;
    } finally {
      if (restoring.get(id) === pending) restoring.delete(id);
    }
  };
  const owned = (id: string) => {
    scope.sync();
    const p = previews.get(id);
    if (!p) throw Error("This preview is no longer connected.");
    return p;
  };
  const state = async (id: string) => {
    const p = owned(id);
    const read = () => call("browserState", p.sessionId);
    const result = (await (p.window && ctx.withCallerWindow
      ? ctx.withCallerWindow(p.window, read)
      : read())) as BrowserState;
    if (previews.get(id) !== p) throw Error("This preview is no longer connected.");
    return result;
  };
  const tabs = (s: BrowserState) => ({
    tabs: s.tabs.map((t) => {
      const viewport = viewportFrame(t.viewport ?? s.viewport);
      const isOrgBlocked = t.error?.description === "BLOCKED_BY_ADMINISTRATOR";
      return {
        tabId: t.id,
        origin: previewTabOrigin(t.url),
        title: t.title,
        faviconUrl: t.faviconUrl,
        loading: t.loading,
        showsErrorPage: !!(t.error || t.crashed),
        toolAccess: s.toolsAvailable && !t.toolAccessBlocked && !isOrgBlocked ? "allowed" : "blocked-policy",
        isOrgBlocked,
        audible: t.audible ?? false,
        muted: s.muted ?? false,
        emulatedViewport: viewport ? { width: viewport.width, height: viewport.height, setBy: "user" } : null,
      };
    }),
    activeTabId: s.activeTabId ?? "",
  });
  const publish = (id: string, s: BrowserState) => {
    const p = owned(id),
      tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (p.publishedVersion !== undefined && s.version <= p.publishedVersion) return;
    p.publishedVersion = s.version;
    if (p.window) {
      const snapshot = tabs(s);
      host.emitTo(
        p.window,
        "Launch",
        "previewTabsChanged",
        p.publicId,
        snapshot.tabs,
        snapshot.activeTabId,
      );
      host.emitTo(
        p.window,
        "Launch",
        "previewUrlChanged",
        p.publicId,
        tab?.url ?? "",
      );
      return;
    }
    const prefix = "dev-" + p.sessionId + ":";
    const sessionId = `local_${p.sessionId}`;
    const previewId = `preview-${sessionId}`;
    const real = s.devServers.flatMap((server) => {
      const { status, startedAt, url } = server;
      if (
        server.source !== "launch.json" || server.command === "" || status === "stopped" ||
        status === "awaiting-approval" || startedAt === undefined
      )
        return [];
      const origin = url && URL.parse(url)?.origin;
      const externalUrl = url && !isLocalHostname(new URL(url).hostname) ? url : undefined;
      const tabId = origin
        ? s.tabs.find((tab) => URL.parse(tab.url)?.origin === origin)?.id
        : undefined;
      return [{
        serverId: prefix + encodeURIComponent(server.name),
        name: server.name,
        cwd: p.cwd,
        sessionId,
        previewId,
        tabId,
        externalUrl,
        status: status === "failed" || status === "crashed" ? "error" as const : status,
        port: server.port ?? 0,
        startedAt: new Date(startedAt).toISOString(),
      }];
    });
    servers.set([
      ...servers
        .get()
        .filter((r) => r.sessionId !== sessionId),
      ...real,
    ]);
    const snapshot = tabs(s);
    host.emit(
      "Launch",
      "previewTabsChanged",
      id,
      snapshot.tabs,
      snapshot.activeTabId,
    );
    host.emit("Launch", "previewUrlChanged", id, tab?.url ?? "");
  };
  const forgetClosedBrowser = (sessionId: string) => {
    for (const [id, preview] of previews) {
      if (preview.sessionId !== sessionId) continue;
      previews.delete(id);
      persist(id);
      if (preview.window) {
        host.emitTo(preview.window, "Launch", "previewTabsChanged", preview.publicId, [], "seed");
        host.emitTo(preview.window, "Launch", "previewUrlChanged", preview.publicId, "");
      } else {
        host.emit("Launch", "previewTabsChanged", id, [], "seed");
        host.emit("Launch", "previewUrlChanged", id, "");
      }
    }
  };
  const startOnce = async (cwd: string, sessionId: string, html?: string) => {
    if (typeof sessionId !== "string" || !sessionId.startsWith("local_"))
      throw Error("Open a desktop Code session to use its browser.");
    const id = sessionId.slice(6);
    const c = await scope.guard(() => ctx.localLoadConversation!(id));
    if (
      !c ||
      c.id !== id ||
      c.mode !== "code" ||
      c.cloudHosted ||
      c.cloudEnvironmentId ||
      ((c.environment?.kind ?? "local") !== "local" &&
        (html !== undefined || !hasOffHostCodeBrowser(c))) ||
      c.cwd !== cwd
    )
      throw Error("The preview does not belong to this working folder.");
    const key = html ? `html-preview-${id}` : `preview-${sessionId}`;
    let s = (await call(
      html ? "officialBrowserOpenFile" : "browserState",
      id,
      ...(html ? [html] : []),
    )) as BrowserState;
    // A never-opened session has no tabs. The official pane needs a real
    // initial tab before it can leave its "Setting up preview" state.
    if (!s.tabs.length) {
      await call("browserNewTab", id);
      s = (await call("browserState", id)) as BrowserState;
    }
    const previous = previews.get(key);
    if (!previous || previous.cwd !== cwd || previous.html !== html) {
      const entry = {
        sessionId: id,
        cwd,
        name: html ? html.split(/[\\/]/).at(-1)! : "Browser",
        ...(html ? { html } : {}),
      };
      previews.set(key, entry);
      persist(key, entry);
    }
    if (pendingLinkRouting.delete(key))
      await call("officialSetBrowserPreviewLinkRouting", id, true);
    publish(key, s);
    return key;
  };
  const start = (cwd: string, sessionId: string, html?: string) => {
    const key = JSON.stringify([cwd, sessionId, html]);
    const existing = previewStarts.get(key);
    if (existing) return existing;
    const pending = startOnce(cwd, sessionId, html).finally(() => {
      if (previewStarts.get(key) === pending) previewStarts.delete(key);
    });
    previewStarts.set(key, pending);
    return pending;
  };
  on("isAvailable", () => true);
  on("isJitlessForced", () => false); // This host does not launch Chromium with --jitless.
  on("getChromeImportAvailability", () => call("getChromeImportAvailability"));
  on("getCoworkChromeImportAvailability", () => call("getCoworkChromeImportAvailability"));
  on("listChromeImportProfiles", () => call("listChromeImportProfiles"));
  on("listChromeImportSites", (id: string, profile?: string) =>
    call("officialListChromeImportSites", owned(id).sessionId, profile),
  );
  on("importChromeLogins", (id: string, ticket: string, roots: string[], keep: boolean) =>
    call("importChromeLogins", owned(id).sessionId, ticket, roots, keep),
  );
  const chromeLoginDates = (entries: ImportedChromeLogin[]) =>
    entries.map(({ root, importedAt }) => ({ root, importedAt: new Date(importedAt).toISOString() }));
  on("listImportedChromeLogins", async (id: string) =>
    chromeLoginDates(await call("listImportedChromeLogins", owned(id).sessionId) as ImportedChromeLogin[]),
  );
  on("removeImportedChromeLogins", async (id: string, root?: string) =>
    chromeLoginDates(await call("officialRemoveImportedChromeLogins", owned(id).sessionId, root) as ImportedChromeLogin[]),
  );
  on("getChromeImportSharedOffer", (id: string, anySite?: boolean) =>
    call("officialChromeImportSharedOffer", owned(id).sessionId, anySite),
  );
  on("acceptChromeImportSharedOffer", async (id: string, keep: boolean) =>
    await call("acceptChromeImportSharedOffer", owned(id).sessionId, keep) === true
      ? { ok: true } : { ok: false, error: "not_applicable" },
  );
  const sessionAt = async (cwd: string) => {
    const window = callers.getStore();
    const focused = window ? focusedSessions.get(window) : undefined;
    const sessions = await scope.guard(() => ctx.localListConversations!());
    const local = sessions.filter(
      (c) =>
        c.mode === "code" &&
        !c.cloudHosted &&
        (c.environment?.kind ?? "local") === "local" &&
        c.cwd === cwd,
    );
    const c = local.find((session) => session.id === focused) ?? local[0];
    if (!c) throw Error("This working folder has no local Code session.");
    return c;
  };
  const serverOwner = async (id: string) => {
    const match = /^dev-([^:]+):(.+)$/.exec(id);
    if (!match) throw Error("Unknown development server.");
    const c = await scope.guard(() => ctx.localLoadConversation!(match[1]));
    if (
      !c ||
      c.id !== match[1] ||
      c.mode !== "code" ||
      c.cloudHosted ||
      !["local", "wsl"].includes(c.environment?.kind ?? "local")
    )
      throw Error("Development server session not found.");
    return { c, name: decodeURIComponent(match[2]) };
  };
  const refreshServers = async (c: any) => {
    const key = await start(c.cwd, "local_" + c.id);
    publish(key, await state(key));
    return key;
  };
  on("setAutoVerify", async (cwd: string, enabled: boolean) => {
    try {
      const c = await sessionAt(cwd);
      const s = (await call("browserState", c.id)) as BrowserState;
      if (!s.launchConfigPath) return false;
      await call("devServersSetAutoVerify", c.id, enabled);
      return true;
    } catch {
      return false;
    }
  });
  on(
    "startFromConfig",
    async (cwd: string, name?: string, sessionId?: string) => {
      try {
        const c = sessionId
          ? await scope.guard(() =>
              ctx.localLoadConversation!(
                sessionId.startsWith("local_") ? sessionId.slice(6) : "",
              ),
            )
          : await sessionAt(cwd);
        if (
          !c ||
          (sessionId !== undefined && sessionId !== `local_${c.id}`) ||
          c.mode !== "code" ||
          c.cloudHosted ||
          (c.environment?.kind ?? "local") !== "local" ||
          c.cwd !== cwd
        )
          throw Error(
            "The development server does not belong to this local session.",
          );
        const s = (await call("browserState", c.id)) as BrowserState;
        const config = s.devServers.find(
          (s) =>
            s.source === "launch.json" &&
            (name === undefined || s.name.toLowerCase() === name.toLowerCase()),
        );
        if (!config) return s.launchConfigError ? { error: s.launchConfigError } : {};
        // Subscribe the preview to real server updates before the process starts.
        const previewId = await start(c.cwd, "local_" + c.id);
        const result = (await call(
          "devServersStart",
          c.id,
          config.name,
        )) as import("../../../shared/browser").DevServerState;
        if (result.status === "stopped") return { refused: true };
        if (result.status !== "running") {
          publish(previewId, await state(previewId));
          let logs: { line: string }[];
          try {
            logs = (await call("officialDevServerLogs", c.id, config.name)) as { line: string }[];
            if (!Array.isArray(logs) || logs.some(row => typeof row?.line !== "string"))
              throw Error("Invalid development server log response.");
          } catch (error) {
            // Preserve the original startup failure and visibly distinguish missing diagnostics.
            return { error: (result.error ?? "The development server did not start.") +
              "\n\nDevelopment server logs could not be read: " + String((error as Error).message ?? error) };
          }
          const detail = logs
            .slice(-12)
            .map((row) => row.line)
            .join("\n")
            .slice(-6000);
          return {
            error:
              (result.error ?? "The development server did not start.") +
              (detail ? "\n\n" + detail : ""),
          };
        }
        const tabId = result.url
          ? await call("officialFocusOrOpenBrowserTab", c.id, result.url, "launch")
          : undefined;
        if (result.url && typeof tabId !== "string")
          return { error: "The server page did not open." };
        const next = await state(previewId);
        publish(previewId, next);
        return {
          serverId: result.command === "" ? previewId : "dev-" + c.id + ":" + encodeURIComponent(result.name),
          previewId,
          tabId,
        };
      } catch (error) {
        return { error: String((error as Error).message ?? error) };
      }
    },
  );
  on("getLogs", async (id: string) => {
    const { c, name } = await serverOwner(id);
    return call("officialDevServerLogs", c.id, name);
  });
  on("getConfiguredServices", async (cwd: string) => {
    try {
      const c = await sessionAt(cwd);
      return await call("officialConfiguredDevServers", c.id);
    } catch {
      return [];
    }
  });
  on("getAutoVerify", async (cwd: string) => {
    try {
      const c = await sessionAt(cwd);
      const s = (await call("browserState", c.id)) as BrowserState;
      return !!s.launchConfigPath && s.devServers.some((server) => server.source === "launch.json") && s.autoVerify !== false;
    } catch {
      return false;
    }
  });
  on("getPreviewLastFrame", async (sessionId: string) => {
    const c = sessionId?.startsWith("local_")
      ? await scope.guard(() => ctx.localLoadConversation!(sessionId.slice(6)))
      : undefined;
    if (!c || c.id !== sessionId.slice(6) || c.mode !== "code" || c.cloudHosted || c.cloudEnvironmentId ||
      ((c.environment?.kind ?? "local") !== "local" && !hasOffHostCodeBrowser(c))) throw Error("Preview frame requires an owned desktop Code session.");
    const s = (await call("browserState", c.id)) as BrowserState;
    const restored = s.tabs.find((t) => t.id === s.activeTabId)?.restored;
    return restored
      ? {
          configName: restored.serverName ?? "Browser",
          jpegBase64: restored.jpegBase64,
        }
      : null;
  });
  on("discardPreviewLastFrame", async (sessionId: string) => {
    if (!sessionId?.startsWith("local_")) return false;
    return call("officialDiscardPreviewFrame", sessionId.slice(6));
  });
  on("detectServerCandidates", async (cwd: string) => {
    try {
      const c = await sessionAt(cwd);
      return await call("officialDevServerCandidates", c.id);
    } catch {
      return [];
    }
  });
  on("detectServerCandidatesWithAgent", async (cwd: string) => {
    try {
      const c = await sessionAt(cwd);
      return await call("officialDetectDevServersWithAgent", c.id);
    } catch {
      return { ok: false, candidates: [], reason: "query-failed" };
    }
  });
  on("addServerFromCandidate", async (cwd: string, candidate: unknown) => {
    try {
      const c = await sessionAt(cwd);
      return await call("officialAddDevServerCandidate", c.id, candidate);
    } catch {
      return { ok: false, reason: "write-failed" };
    }
  });
  host.on("LocalSessions.setVisibility", (id: unknown, visible: unknown, reason?: unknown) => {
    const window = host.caller ?? host.window;
    if (!window || typeof id !== "string" || !id.startsWith("local_") ||
        typeof visible !== "boolean" || !scope.sync().owner || ctx.isCurrent?.() === false)
      return;
    if (!visible && (reason === "blur" || reason === undefined) && window.isFocused()) return;
    if (!visible) hiddenSessions.set(window, id.slice(6));
    else if (hiddenSessions.get(window) === id.slice(6)) hiddenSessions.delete(window);
    ctx.setOfficialCodeVisibility?.(window, id.slice(6), visible);
  });
  // The official local pane opens its existing server rather than calling
  // startBrowserPreview from the toolbar. Prepare only the current account's
  // focused session; publishing does not show or navigate the native view.
  host.on("LocalSessions.setFocusedSession", (sessionId?: string) => {
    focusCodeFiles?.(sessionId);
    const window = host.caller ?? host.window;
    return scope.run(async () => {
      if (window) {
        if (sessionId?.startsWith("local_")) focusedSessions.set(window, sessionId.slice(6));
        else {
          focusedSessions.delete(window);
          hiddenSessions.delete(window);
        }
      }
      if (!sessionId?.startsWith("local_")) return;
      const c = await scope.guard(() =>
        ctx.localLoadConversation!(sessionId.slice(6)),
      );
      if (
        !c?.cwd ||
        c.mode !== "code" ||
        c.cloudHosted ||
        c.cloudEnvironmentId ||
        ((c.environment?.kind ?? "local") !== "local" && !hasOffHostCodeBrowser(c))
      )
        return;
      const key = `preview-${sessionId}`;
      if (!previews.has(key) || previews.get(key)?.cwd !== c.cwd)
        await start(c.cwd, sessionId);
    });
  });
  on("startBrowserPreview", start);
  on(
    "loadHtmlPreview",
    async (file: string, sessionId: string, cwd?: string) => {
      const c = sessionId?.startsWith("local_")
        ? await scope.guard(() =>
            ctx.localLoadConversation!(sessionId.slice(6)),
          )
        : undefined;
      if (!c?.cwd)
        throw Error("Open a local Code session to preview this file.");
      return start(cwd ?? c.cwd, sessionId, file);
    },
  );
  on("getPreviewTabs", async (id: string) =>
    previews.has(id)
      ? tabs(await state(id))
      : { tabs: [], activeTabId: "seed" },
  );
  on("getAllSessionPreviewTabs", async () =>
    Promise.all(
      [...previews.keys()]
        .filter((id) => !previews.get(id)?.window)
        .map(async (id) => ({
          serverId: id,
          ...tabs(await state(id)),
        })),
    ),
  );
  on("getPreviewUrl", async (id: string) => {
    if (!previews.has(id)) return null;
    const s = await state(id);
    return s.tabs.find((t) => t.id === s.activeTabId)?.url || null;
  });
  on("getPreviewNavState", async (id: string, tabId?: string) => {
    if (!previews.has(id)) return { canGoBack: false, canGoForward: false };
    const s = await state(id),
      tab = s.tabs.find((t) => t.id === (tabId ?? s.activeTabId));
    return {
      canGoBack: tab?.canGoBack ?? false,
      canGoForward: tab?.canGoForward ?? false,
    };
  });
  on(
    "showPreview",
    async (
      id: string,
      bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
        radius?: number;
        parked?: boolean;
      },
      claimant?: string,
      targetWindowId?: string,
    ) => {
      if (targetWindowId !== undefined && targetWindowId !== String(callers.getStore()?.id))
        return false;
      const preview = previews.get(id);
      return preview
        ? call("officialShowBrowserPreview", preview.sessionId, preview.publicId ?? id, bounds, claimant)
        : false;
    },
  );
  on("hidePreview", (id: string, claimant?: string, targetWindowId?: string) => {
    if (targetWindowId !== undefined && targetWindowId !== String(callers.getStore()?.id))
      return false;
    const preview = previews.get(id);
    return preview ? call("officialHideBrowserPreview", preview.sessionId, claimant) : false;
  });
  on("focusPreview", (id: string, targetWindowId?: string) => {
    const window = callers.getStore();
    if (
      !window ||
      (targetWindowId !== undefined && targetWindowId !== String(window.id))
    )
      return false;
    return previews.has(id)
      ? call("officialFocusBrowserPreview", owned(id).sessionId)
      : false;
  });
  on("setPreviewChromeFocus", (id: string, focused: boolean) =>
    call(
      "officialConfigurePreviewInput",
      owned(id).sessionId,
      owned(id).publicId ?? id,
      { chromeFocused: focused },
    ),
  );
  on("setPreviewPaneShortcutArmed", (id: string, armed: boolean) =>
    call(
      "officialConfigurePreviewInput",
      owned(id).sessionId,
      owned(id).publicId ?? id,
      { armed },
    ),
  );
  on("setPreviewPaneMounted", (id: string) => previews.has(id));
  on("navigatePreview", async (id: string, url: string, tabId?: string) => {
    const preview = previews.get(id);
    if (!preview) return false;
    const result = (await call(
      "browserNavigate",
      preview.sessionId,
      url,
      tabId,
    )) as BrowserNavigateResult;
    if (!result.ok) return false;
    publish(id, await state(id));
    return true;
  });
  on("openPreviewTab", async (id: string, cwd?: string) => {
    if (!previews.has(id) && cwd && id.startsWith("preview-local_"))
      await start(cwd, id.slice("preview-".length));
    if (!previews.has(id)) return null;
    const tab = await call("officialNewBrowserPreviewTab", owned(id).sessionId);
    if (typeof tab !== "string") return null;
    publish(id, await state(id));
    return tab;
  });
  const openPreviewLink = async (id: string, cwd: string, url: string, source: "server" | "external" | "clicked") => {
    if (!previews.has(id) && id.startsWith("preview-local_")) {
      const sessionId = id.slice("preview-".length);
      const conversation = await scope.guard(() => ctx.localLoadConversation!(sessionId.slice(6)));
      if (conversation?.cwd !== cwd) return null;
      await start(cwd, sessionId);
    }
    const preview = previews.get(id);
    if (!preview || preview.cwd !== cwd) return null;
    const tab = await call("officialFocusOrOpenBrowserTab", preview.sessionId, url, source);
    if (typeof tab !== "string") return null;
    publish(id, await state(id));
    return tab;
  };
  on("focusOrOpenPreviewTab", (id: string, cwd: string, url: string) => openPreviewLink(id, cwd, url, "server"));
  on("openExternalLinkInPreview", (id: string, cwd: string, url: string) => openPreviewLink(id, cwd, url, "external"));
  on("openClickedLinkInPreview", ({ previewId, cwd, url }: { previewId: string; cwd: string; url: string }) =>
    openPreviewLink(previewId, cwd, url, "clicked"),
  );
  on("openPreviewInBrowser", (id: string, tabId?: string) =>
    previews.has(id) && call("officialOpenBrowserPreviewExternally", owned(id).sessionId, tabId),
  );
  on("setPreviewLinkRouting", (id: string, enabled: boolean) => {
    const preview = previews.get(id);
    if (preview) return call("officialSetBrowserPreviewLinkRouting", preview.sessionId, enabled);
    if (enabled) pendingLinkRouting.add(id);
    else pendingLinkRouting.delete(id);
  });
  on("openRoutedLinkExternally", (id: string, url: string) =>
    call("officialOpenRoutedBrowserLink", previews.get(id)?.publicId ?? id, url),
  );
  on("setRoutedLinkConfirmReady", (ready: boolean) => call("setRoutedLinkConfirmReady", ready));
  on("resolveRoutedLinkConfirm", (requestId: string, allow: boolean) =>
    call("resolveRoutedLinkConfirm", requestId, allow),
  );
  for (const [name, method] of [
    ["goBack", "browserBack"],
    ["goForward", "browserForward"],
    ["refreshPreview", "browserReload"],
  ])
    on(name, (id: string, tabId?: string) =>
      previews.has(id) && call(method, owned(id).sessionId, tabId),
    );
  on("setActivePreviewTab", (id: string, tab: string) =>
    previews.has(id) && call("officialSelectBrowserPreviewTab", owned(id).sessionId, tab),
  );
  on(
    "closePreviewTab",
    async (id: string, tab: string, reopenable?: boolean) => {
      const preview = previews.get(id);
      if (!preview) return false;
      const closed = await call(
        "officialCloseBrowserPreviewTab",
        preview.sessionId,
        tab,
        reopenable === true,
      );
      if (closed === "destroyed") {
        if (previews.get(id) === preview) forgetClosedBrowser(preview.sessionId);
        return true;
      }
      if (closed === true && previews.get(id) === preview) publish(id, await state(id));
      return closed === true;
    },
  );
  on("reopenClosedPreviewTab", async (id: string) => {
    if (!previews.has(id)) return null;
    const tab = await call("officialReopenBrowserTab", owned(id).sessionId);
    publish(id, await state(id));
    return tab;
  });
  on("reorderPreviewTab", async (id: string, tab: string, index: number) => {
    if (!previews.has(id)) return false;
    const reordered = await call("officialReorderBrowserTab", owned(id).sessionId, tab, index);
    if (reordered) publish(id, await state(id));
    return reordered;
  });
  on("closeAllPreviewTabs", async (id: string) => {
    if (!previews.has(id)) return false;
    await call("officialCloseAllBrowserTabs", owned(id).sessionId);
    publish(id, await state(id));
    return true;
  });
  on("setPreviewViewport", (id: string, width: number, height: number, tabId?: string) =>
    previews.has(id) && call("officialSetBrowserViewport", owned(id).sessionId, { width, height }, tabId),
  );
  on("clearPreviewViewport", (id: string, tabId?: string) =>
    previews.has(id) && call("officialSetBrowserViewport", owned(id).sessionId, "desktop", tabId),
  );
  on("setPreviewColorScheme", (id: string, scheme: string, tabId?: string) =>
    previews.has(id) && call("officialSetBrowserColorScheme", owned(id).sessionId, scheme, tabId),
  );
  on("setPreviewMuted", (id: string, muted: boolean) =>
    previews.has(id) && call("officialMuteBrowserPreview", owned(id).sessionId, muted),
  );
  on("clearPreviewBrowsingData", async (id: string) => {
    if (!previews.has(id)) return false;
    if (await call("officialClearPreviewBrowsingData", owned(id).sessionId) === true)
      await resetChromeImportPrompt?.();
    return true;
  });
  on("clearCoworkBrowserData", async () => {
    if (await call("clearCoworkBrowserData") !== true) return false;
    await resetChromeImportPrompt?.();
    return true;
  });
  on("getPreviewAllowedOrigins", () => call("getPreviewAllowedOrigins"));
  on("addPreviewAllowedOrigin", (origin: string, schemeless?: boolean) =>
    call("addPreviewAllowedOrigin", origin, schemeless),
  );
  on("removePreviewAllowedOrigin", (origin: string) => call("removePreviewAllowedOrigin", origin));
  on("clearPreviewAllowedOrigins", () => call("clearPreviewAllowedOrigins"));
  on("toggleSelectionMode", (id: string, enabled: boolean, tabId?: string) => {
    const preview = previews.get(id);
    return preview
      ? call("officialToggleBrowserSelection", preview.sessionId, preview.publicId ?? id, enabled, tabId)
      : false;
  });
  const screenshot = (id: string, options: { tabId?: string; origin?: string; ifChanged?: boolean; force?: boolean }) => {
    const preview = previews.get(id);
    return preview ? call("officialCaptureBrowserPreview", preview.sessionId, options) : null;
  };
  on("capturePreviewScreenshot", (id: string, tabId?: string, targetWindowId?: string) =>
    targetWindowId !== undefined && targetWindowId !== String(callers.getStore()?.id)
      ? null
      : screenshot(id, { tabId }),
  );
  on("capturePreviewScreenshotIfChanged", async (id: string, force?: boolean, targetWindowId?: string) =>
    targetWindowId !== undefined && targetWindowId !== String(callers.getStore()?.id)
      ? ""
      : await screenshot(id, { ifChanged: true, force }) ?? "",
  );
  on("capturePreviewTabIfChanged", async ({ serverId, tabId, origin, force }: { serverId: string; tabId: string; origin: string; force?: boolean }) =>
    await screenshot(serverId, { tabId, origin, ifChanged: true, force }) ?? "",
  );
  on("exportPreview", async (id: string, kind: string) => {
    if (!previews.has(id)) return null;
    const method = kind === "file" ? "browserExportFile" : kind === "screenshot" ? "browserSaveScreenshot" : undefined;
    return method ? call(method, owned(id).sessionId) : null;
  });
  on("previewSnapshot", (id: string) =>
    call("browserSnapshot", owned(id).sessionId),
  );
  on("previewConsoleLogs", (id: string, options?: object) =>
    call("browserConsoleLogs", owned(id).sessionId, options),
  );
  on("destroyPreview", async (id: string) => {
    if (!previews.has(id)) return;
    const entry = owned(id);
    await call(
      entry.window ? "officialCloseBrowserPreview" : "browserHide",
      entry.sessionId,
    );
    previews.delete(id);
    persist(id);
  });
  on("stopServer", async (id: string) => {
    if (id.startsWith("dev-")) {
      const { c, name } = await serverOwner(id);
      await call("devServersStop", c.id, name);
      await refreshServers(c);
      return true;
    }
    if (!previews.has(id)) return false;
    const sessionId = owned(id).sessionId;
    await call("officialCloseBrowserPreview", sessionId);
    forgetClosedBrowser(sessionId);
    return true;
  });
  const revealSessionPreview = (
    id: string,
    paths?: string[],
  ) => scope.run(async () => {
    const sessionId = "local_" + id;
    const watching = (window: NonNullable<typeof host.window>) =>
      !window.isDestroyed() && !window.webContents.isDestroyed() &&
      focusedSessions.get(window) === id &&
      hiddenSessions.get(window) !== id &&
      URL.parse(window.webContents.mainFrame.url)?.pathname === "/epitaxy/" + sessionId;
    const allowed = () => paths === undefined || autoOpenFiles();
    if (!scope.sync().owner || !allowed() || !ctx.localLoadConversation) return;
    const windows = host.currentWindows().filter(watching);
    const window = windows.find(window => window.isFocused()) ?? windows[0];
    if (!window) return;
    const current = () => ctx.isCurrent?.() !== false &&
      host.windowForId(window.id) === window && watching(window) && allowed();
    const c = await scope.guard(() => ctx.localLoadConversation!(id));
    if (!c?.cwd || c.mode !== "code" || c.archived || !current() ||
        (!hasLocalBrowserExecution(c) && (paths !== undefined || !hasOffHostCodeBrowser(c)))) return;
    const cwd = c.cwd;
    const open = async () => {
      const result = (paths === undefined
        ? await call("browserState", id)
        : await call("officialPreviewWrittenFiles", id, paths, current)) as BrowserState | null;
      if (!result?.activeTabId || !current()) return;
      const previewId = "preview-" + sessionId;
      if (!previews.has(previewId)) {
        const entry = { sessionId: id, cwd, name: "Browser" };
        previews.set(previewId, entry);
        persist(previewId, entry);
      }
      publish(previewId, result);
      host.emitTo(window, "Launch", "previewRevealRequested", previewId, sessionId, result.activeTabId);
    };
    await (ctx.withCallerWindow ? ctx.withCallerWindow(window, open) : open());
  });

  return ctx.onEvent((event) => {
    if (ctx.isCurrent?.() === false) return;
    scope.sync();
    if (event.type === "browser-reveal" || event.type === "code-files-written") {
      void revealSessionPreview(
        event.conversationId,
        event.type === "code-files-written" ? event.paths : undefined,
      ).catch(() => ctx.log("[official-ui] Preview could not be opened."));
      return;
    }
    if (event.type === "official-preview-link-confirm") {
      const window = host.windowForId(event.windowId);
      if (window) host.emitTo(window, "Launch", "routedLinkConfirmRequested", event.requestId, event.previewId, event.url);
      return;
    }
    if (event.type === "official-preview-event") {
      for (const [id, p] of previews) {
        if (
          p.sessionId !== event.conversationId ||
          (p.publicId ?? id) !== event.previewId
        )
          continue;
        const window = p.window ?? host.windowForId(event.windowId);
        if (!window || window.id !== event.windowId) continue;
        host.emitTo(
          window,
          "Launch",
          event.event,
          event.previewId,
          ...event.args,
        );
      }
      return;
    }
    if (event.type !== "browser") return;
    for (const [id, p] of previews)
      if (p.sessionId === event.state.conversationId)
        void state(id)
          .then((s) => publish(id, s))
          .catch((error) =>
            ctx.log("[official-ui] preview update", String(error)),
          );
  });
}
