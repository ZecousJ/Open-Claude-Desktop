import { extensionDropPaths, takeExtensionDropFile } from "./extension-drop";
import { observeConversationListUpdates } from "./conversation-list-updates";
/**
 * The native side of the official preload (build/official-ui/host/official-preload.cjs).
 * Every `$eipc` channel of the recovered contract (data/native-ipc-contract.json)
 * is registered once and dispatched by its operation, "Domain.method", to the
 * handler a domain module registered (electron/official-ui/native/*.ts). The
 * official desktop main process's own schema (work/official-native/schema.json,
 * scripts/extract-native-schema.mjs) is the reference for each method's
 * arguments, answer and events.
 *
 * Three outcomes are kept apart in the log so a gap is never silent:
 *   - an answer;
 *   - a NativeRefusal: what the official app also answers in this situation
 *     (unsupported build, no hardware key, feature off), logged as "refused";
 *   - no handler: "Native host adapter is not configured", counted as a gap.
 */
import fs from "node:fs";
import { createNativeInvocationScope } from "./invocation-scope";
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import type { AdapterContext } from "../api/context";
import {
  AttachmentSelectionGrants,
  attachmentSelectionChannel,
  attachmentSelectionRoute,
  CoworkDraftSelectionTransition,
  observeAttachmentSelectionNavigation,
  acceptAttachmentSelection,
  verifyAttachmentSelectionFrame,
} from "./attachment-selection-grants";
import { observeBrowserNavigation } from "./browser-navigation";
import { observeWindowActivity, observeWindowPresentation } from "./window-activity";
import { observeOfficialAppMenu } from "./app-menu";

/** An answer the official app gives too: the feature is off or unavailable here. */
export class NativeRefusal extends Error {
  code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "NativeRefusal";
    this.code = code;
  }
}

export type NativeHandler = (...args: any[]) => unknown;

export interface NativeStore<T> {
  get(): T;
  set(next: T): void;
  update(change: (current: T) => T): void;
}

interface Contract {
  invokes: { channel: string }[];
  sync: { channel: string }[];
}

export class NativeHost {
  readonly ctx: AdapterContext;
  private invocation: ReturnType<typeof createNativeInvocationScope>;
  readonly attachmentSelections: AttachmentSelectionGrants;
  private extensionDrops = new WeakMap<object, { identity: unknown; files: Set<string> }>();
  takeExtensionDrop(window: BrowserWindow, file: unknown) {
    const selection = this.extensionDrops.get(window);
    if (typeof file !== "string" || !selection || selection.identity !== this.ctx.sessionIdentity?.())
      throw Error("Drop the extension file again.");
    return takeExtensionDropFile(selection.files, file);
  }
  private selectionEpoch = new WeakMap<BrowserWindow, number>();
  private coworkDraftSelection = new CoworkDraftSelectionTransition();
  private handlers = new Map<string, NativeHandler>();
  private stores = new Map<string, NativeStore<unknown>>();
  /** The namespaces ("claude.web", "claude.settings", …) each domain's channels use. */
  private namespaces = new Map<string, Set<string>>();
  private prefix = "";
  private channels: { channel: string; op: string; sync: boolean }[] = [];
  private gaps = new Set<string>();
  private refusalsLogged = new Set<string>();
  private disposers: (() => void)[] = [];
  /** Answers for operations no domain module claims yet (electron/official-ui/native/legacy.ts). */
  fallback?: (op: string, args: unknown[]) => unknown;

  /** The official windows this host serves (the main one and any others). */
  private windows = new Set<BrowserWindow>();
  private windowBindings = new WeakMap<BrowserWindow, { origin: string; current(): boolean }>();
  private currentWindow(window: BrowserWindow) {
    const binding = this.windowBindings.get(window);
    try { return this.windows.has(window) && !window.isDestroyed() && binding?.current() === true; }
    catch { return false; }
  }
  private folderSelections = new WeakMap<BrowserWindow, Map<string, { owner: string | undefined; activation: unknown; expires: number; version: number }>>();
  recordFolderSelection(window: BrowserWindow | undefined, folders: readonly string[], purpose: "workspace" | "settings" = "workspace") {
    if (!window || !this.currentWindow(window)) throw Error("This account window has retired.");
    const owner = this.ctx.account()?.id;
    const activation = this.ctx.sessionIdentity?.();
    const selections = this.folderSelections.get(window) ?? new Map();
    for (const folder of folders)
      selections.set(`${purpose}\0${folder}`, { owner, activation, expires: Date.now() + 15 * 60_000, version: this.selectionVersion(window) });
    this.folderSelections.set(window, selections);
  }
  hasFolderSelection(window: BrowserWindow | undefined, folder: string, purpose: "workspace" | "settings" = "workspace") {
    if (!window || !this.currentWindow(window)) return false;
    const selection = this.folderSelections.get(window)?.get(`${purpose}\0${folder}`);
    return !!selection && selection.expires > Date.now() &&
      (purpose !== "settings" || selection.version === this.selectionVersion(window)) &&
      selection.owner === this.ctx.account()?.id &&
      selection.activation === this.ctx.sessionIdentity?.();
  }
  private originFor(window: BrowserWindow) {
    const binding = this.windowBindings.get(window);
    if (!binding || !this.currentWindow(window)) throw Error("This account window has retired.");
    return binding.origin;
  }
  private windowDisposers = new Map<BrowserWindow, (() => void)[]>();

  onWindowDetach(window: BrowserWindow, cleanup: () => void) {
    const disposers = this.windowDisposers.get(window);
    if (!disposers) throw Error("This account window has retired.");
    disposers.push(cleanup);
  }

  /** The window whose page made the call being answered (read synchronously by handlers). */
  caller: BrowserWindow | undefined;

  constructor(
    readonly origin: string,
    ctx: AdapterContext,
  ) {
    this.invocation = createNativeInvocationScope(ctx);
    this.ctx = this.invocation.context;
    this.attachmentSelections = new AttachmentSelectionGrants(() => ({
      owner: ctx.account()?.id,
      activation: ctx.sessionIdentity?.(),
    }));
    const contract: Contract = JSON.parse(
      fs.readFileSync(
        path.join(ctx.root, "data", "native-ipc-contract.json"),
        "utf8",
      ),
    );
    this.channels.push({
      channel: "claudex:export-account-data",
      op: "claudex:export-account-data",
      sync: false,
    });
    // The preload's event-only namespaces have no invoke or sync contract.
    this.namespaces.set("Navigation", new Set(["claude.web"]));
    this.namespaces.set("MenuEvents", new Set(["claude.web"]));
    this.namespaces.set("DeepLink", new Set(["claude.web"]));
    for (const [list, sync] of [
      [contract.invokes, false],
      [contract.sync, true],
    ] as const)
      for (const { channel } of list) {
        const parts = channel.split("_$_");
        if (parts.length < 4) {
          this.channels.push({ channel, op: channel, sync });
          continue;
        }
        this.prefix ||= `${parts[0]}_$_`;
        const [namespace, domain] = [parts[1], parts[2]];
        if (!this.namespaces.has(domain))
          this.namespaces.set(domain, new Set());
        this.namespaces.get(domain)!.add(namespace);
        this.channels.push({
          channel,
          op: `${domain}.${parts.slice(3).join("_$_")}`,
          sync,
        });
      }
  }

  /** Registers the handler of "Domain.method". */
  on(op: string, handler: NativeHandler) {
    this.handlers.set(op, handler);
    return this;
  }

  /** Answers several operations with one value (a constant answer the official app gives in this state). */
  answer(value: unknown, ...ops: string[]) {
    for (const op of ops) this.handlers.set(op, () => structuredClone(value));
    return this;
  }

  /** Serves one more official window; it leaves when it closes. */
  attach(window: BrowserWindow, binding = { origin: this.origin, current: () => true }) {
    if (this.windows.has(window)) return;
    if (!binding.current()) throw new Error("This account window has retired.");
    this.windowBindings.set(window, binding);
    this.windows.add(window);
    const cleanup: (() => void)[] = [];
    this.windowDisposers.set(window, cleanup);
    const closed = () => {
      try {
        this.detach(window);
      } catch {
        // Natural Electron events must not turn one window's cleanup failure
        // into an uncaught application error. Explicit detach still throws.
        try {
          this.ctx.log(
            "[official-ui] native window cleanup was not confirmed.",
          );
        } catch {}
      }
    };
    cleanup.push(() => window.removeListener("closed", closed));
    try {
      window.once("closed", closed);
      cleanup.push(observeConversationListUpdates(window, this.ctx, () => this.currentWindow(window)));
      cleanup.push(observeBrowserNavigation(window.webContents, binding.origin, state => {
        this.emitTo(window, "BrowserNavigation", "navigationState_$store$_update", state);
      }));
      cleanup.push(observeOfficialAppMenu(window, {
        origin: binding.origin, current: () => this.currentWindow(window),
        log: message => this.ctx.log(message),
        openSettings: () => this.emitTo(window, "Navigation", "navigate", "/settings/general"),
        toggleSidebar: () => this.emitTo(window, "MenuEvents", "toggleSidebar", "menu"),
        selectArea: id => this.emitTo(window, "MenuEvents", "selectArea", id),
        openCommandPalette: search => this.emitTo(window, "MenuEvents", "openCommandPalette", search),
        sessionMenu: (event, ...args) => this.emitTo(window, "MenuEvents", event, ...args),
        splitMenu: command => this.emitTo(window, "MenuEvents", "splitViewCommand", command),
      }));
      cleanup.push(
        observeAttachmentSelectionNavigation(window.webContents, (url, phase) => {
          this.selectionEpoch.set(
            window,
            (this.selectionEpoch.get(window) ?? 0) + 1,
          );
          if (!this.coworkDraftSelection.navigate(window, url, phase))
            this.attachmentSelections.revokeWindow(window);
          this.extensionDrops.delete(window);
        }),
      );
      cleanup.push(observeWindowPresentation(window, (event, value) =>
        this.emitTo(window, "WindowState", event, value),
      ));
      cleanup.push(
        observeWindowActivity(window, (active) => {
          this.emitTo(window, "WindowState", "windowActiveChanged", active);
          queueMicrotask(() =>
            this.emit(
              "WindowState",
              "appFocusChanged",
              this.isAnyWindowFocused(),
            ),
          );
        }),
      );
    } catch (error) {
      this.detach(window);
      throw error;
    }
  }

  /** Revoke only this window before fallible destruction. This does not cancel
   * already-dispatched work or the separate HTTP/window-manager transports. */
  detach(window: BrowserWindow) {
    const existed = this.windows.delete(window);
    this.windowBindings.delete(window);
    if (this.caller === window) this.caller = undefined;
    this.attachmentSelections.revokeWindow(window);
    this.coworkDraftSelection.clear(window);
    const cleanup = this.windowDisposers.get(window) ?? [];
    this.windowDisposers.delete(window);
    let failed = false;
    for (const dispose of cleanup) {
      try {
        dispose();
      } catch {
        failed = true;
      }
    }
    if (existed) {
      try {
        this.emit("WindowState", "appFocusChanged", this.isAnyWindowFocused());
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw new Error("Official window native cleanup was not confirmed.");
  }

  selectionVersion(window: BrowserWindow) {
    if (!this.currentWindow(window)) throw Error("This account window has retired.");
    return this.selectionEpoch.get(window) ?? 0;
  }

  private selectedFileScope(window: BrowserWindow, targetSession?: string, surface?: "task" | "epitaxy") {
    if (!this.currentWindow(window))
      throw Error("Untrusted file selection window.");
    const route = attachmentSelectionRoute(
      window.webContents.mainFrame.url,
      this.originFor(window),
      targetSession,
      surface,
    );
    return `${this.selectionEpoch.get(window) ?? 0}:${route}`;
  }

  takeSelectedAttachments(
    window: BrowserWindow,
    paths: string[],
    budget: number,
    targetSession: string,
    newSessionId?: string,
  ) {
    if (!this.currentWindow(window)) throw Error("Untrusted file selection window.");
    const pending = this.coworkDraftSelection.take(window, window.webContents.mainFrame.url, newSessionId);
    if (pending && targetSession === "new")
      return this.attachmentSelections.take(window, paths, budget, pending);
    return this.attachmentSelections.take(
      window,
      paths,
      budget,
      this.selectedFileScope(window, targetSession, "task"),
    );
  }

  takeCodeComposerAttachments(
    window: BrowserWindow,
    paths: string[],
    budget: number,
    targetSession: string,
  ) {
    const scope = this.selectedFileScope(window, targetSession, "epitaxy");
    const selected = this.attachmentSelections.matchingPaths(window, paths, scope);
    return selected.length ? this.attachmentSelections.take(window, selected, budget, scope) : [];
  }

  grantQueuedCodeAttachments(window: BrowserWindow, paths: string[], targetSession: string) {
    const scope = this.selectedFileScope(window, targetSession, "epitaxy");
    this.attachmentSelections.grant(window, paths, scope);
  }

  isAnyWindowFocused() {
    return [...this.windows].some(
      (window) => this.currentWindow(window) && window.isFocused(),
    );
  }
  currentWindows() {
    return [...this.windows].filter((window) => this.currentWindow(window));
  }

  windowForId(id: number) {
    return [...this.windows].find(
      (window) => window.id === id && this.currentWindow(window),
    );
  }

  /** The main official window (the first still open). */
  get window(): BrowserWindow | undefined {
    for (const window of this.windows) if (this.currentWindow(window)) return window;
    return undefined;
  }

  /** Sends a domain event ("Domain", "eventName", ...positional arguments) to every official window. */
  emit(domain: string, event: string, ...args: unknown[]) {
    for (const window of this.windows)
      this.emitTo(window, domain, event, ...args);
  }

  /** Window-scoped events must reach only that window's official preload. */
  emitTo(
    window: BrowserWindow,
    domain: string,
    event: string,
    ...args: unknown[]
  ) {
    if (!this.currentWindow(window)) return;
    for (const namespace of this.namespaces.get(domain) ?? [])
      window.webContents.send(
        `${this.prefix}${namespace}_$_${domain}_$_${event}`,
        ...args,
      );
  }

  /** A main-owned state the page reads (`…_$store$_getState`) and follows (`…_$store$_update`). */
  store<T>(domain: string, name: string, initial: T): NativeStore<T> {
    const key = `${domain}.${name}`;
    const existing = this.stores.get(key);
    if (existing) return existing as NativeStore<T>;
    let value = initial;
    const store: NativeStore<T> = {
      get: () => value,
      set: (next) => {
        value = next;
        this.emit(domain, `${name}_$store$_update`, value);
      },
      update: (change) => store.set(change(value)),
    };
    this.stores.set(key, store as NativeStore<unknown>);
    this.on(`${domain}.${name}_$store$_getState`, () => value);
    this.on(`${domain}.${name}_$store$_getStateSync`, () => value);
    return store;
  }

  has(op: string) {
    return this.handlers.has(op);
  }

  broadcastRaw(channel: string, ...args: unknown[]) {
    for (const window of this.windows)
      if (this.currentWindow(window)) window.webContents.send(channel, ...args);
  }

  private async dispatch(op: string, args: unknown[]) {
    const handler = this.handlers.get(op);
    try {
      if (handler) return await handler(...args);
      if (this.fallback) return await this.fallback(op, args);
      throw new Error(`Native host adapter is not configured: ${op}`);
    } catch (error) {
      if (error instanceof NativeRefusal) {
        if (!this.refusalsLogged.has(op))
          this.ctx.log(`[official-ui] native refused ${op}: ${error.code}`);
        this.refusalsLogged.add(op);
      } else if (
        error instanceof Error &&
        error.message.startsWith("Native host adapter is not configured")
      )
        this.gaps.add(op);
      throw error;
    }
  }

  private dispatchSync(op: string) {
    const handler = this.handlers.get(op);
    if (handler) return handler();
    if (this.fallback) return this.fallback(op, []);
    this.gaps.add(op);
    throw new Error(`Native host adapter is not configured: ${op}`);
  }

  /** Registers every contract channel with Electron. */
  start() {
    // Only an official window's own top frame, on the loopback origin.
    const verify = (
      event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (
        !window ||
        !this.currentWindow(window) ||
        event.senderFrame !== event.sender.mainFrame ||
        URL.parse(event.senderFrame.url)?.origin !== this.originFor(window)
      )
        throw new Error("Untrusted IPC sender");
      this.caller = window;
      return window;
    };
    // This channel is NOT in the official API dispatch table and is never
    // exposed to the page. Only our isolated preload's trusted File listener
    // sends it; all existing sender/window/top-frame/origin checks still apply.
    const selected = (event: Electron.IpcMainEvent, paths: unknown) => {
      try {
        event.returnValue = acceptAttachmentSelection(
          event,
          paths,
          (event) => {
            const window = verify(event);
            verifyAttachmentSelectionFrame(event, this.originFor(window));
            return window;
          },
          this.attachmentSelections,
          (window) => this.selectedFileScope(window as BrowserWindow),
        );
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window && new URL(event.senderFrame!.url).pathname === "/new")
          this.coworkDraftSelection.selected(window, this.selectedFileScope(window), this.originFor(window));
      } catch {
        event.returnValue = false;
      }
    };
    const extensionDrop = (event: Electron.IpcMainEvent, paths: unknown) => {
      try {
        const window = verify(event);
        const url = new URL(event.senderFrame!.url);
        if (url.pathname !== "/epitaxy" || !/^#settings\/desktop\/extensions(?:\/|$)/.test(url.hash))
          throw Error("Invalid extension drop.");
        const files = extensionDropPaths(paths);
        this.extensionDrops.set(window, { identity: this.ctx.sessionIdentity?.(), files });
        event.returnValue = true;
      } catch { event.returnValue = false; }
    };
    ipcMain.on("claudex:extension-drop", extensionDrop);
    this.disposers.push(() => ipcMain.removeListener("claudex:extension-drop", extensionDrop));
    ipcMain.on(attachmentSelectionChannel, selected);
    this.disposers.push(() =>
      ipcMain.removeListener(attachmentSelectionChannel, selected),
    );
    for (const { channel, op, sync } of this.channels) {
      // The official window manager registers its own channels.
      if (channel.includes("_$_electron_window_$_WindowManager_$_")) continue;
      if (sync) {
        const listener = (event: Electron.IpcMainEvent) => {
          try {
            const window = verify(event);
            event.returnValue = { result: this.invocation.run(
              { current: () => this.currentWindow(window) }, () => this.dispatchSync(op)) };
          } catch (error) {
            event.returnValue = { error: (error as Error).message };
          }
        };
        ipcMain.on(channel, listener);
        this.disposers.push(() => ipcMain.removeListener(channel, listener));
      } else {
        ipcMain.handle(channel, (event, ...args) => {
          const window = verify(event);
          const dispatch = async () => {
            const result = await this.invocation.run(
              { current: () => this.currentWindow(window) }, () => this.dispatch(op, args));
            if (!this.currentWindow(window)) throw new Error("This account window has retired.");
            return result;
          };
          return this.ctx.withCallerWindow
            ? this.ctx.withCallerWindow(window, dispatch)
            : dispatch();
        });
        this.disposers.push(() => ipcMain.removeHandler(channel));
      }
    }
    return this;
  }

  /** Operations the page called that nothing answers. */
  unanswered() {
    return [...this.gaps];
  }

  dispose() {
    let failed = false;
    for (const window of [...this.windows]) {
      try {
        this.detach(window);
      } catch {
        failed = true;
      }
    }
    try {
      this.attachmentSelections.clear();
    } catch {
      failed = true;
    }
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw new Error("Official native host cleanup was not confirmed.");
  }
}
