import {
  commandTimeoutMs,
  Ring,
  namedKeys,
  AXNode,
  formatAXTree,
  clip,
  pageText,
} from "./cdp-support";
import * as cdpEvents from "./cdp-events";
import { installMethods } from "./install-methods";
import * as cdpInput from "./cdp-input";
import * as cdpInspect from "./cdp-inspect";

/** What CdpDriver uses of Electron's `webContents.debugger`. */
export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  isAttached(): boolean;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<any>;
  on(
    event: "message",
    listener: (event: unknown, method: string, params: any) => void,
  ): unknown;
  on(
    event: "detach",
    listener: (event: unknown, reason: string) => void,
  ): unknown;
}

export interface CdpHooks {
  /** A confirm, prompt or beforeunload dialog opened (alerts are accepted at once). */
  dialogOpened?(dialog: {
    type: "confirm" | "prompt" | "beforeunload";
    message: string;
    url: string;
    defaultPrompt?: string;
  }): void;
  /** The page's dialog closed (answered here or by the page going away). */
  dialogClosed?(): void;
  /** The main frame went to a new document (refs are gone). */
  navigated?(): void;
  /** The platform's name, for keyboard shortcuts ("darwin" uses ⌘). */
  platform?: string;
}

export interface ConsoleEntry {
  source?: string;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  url?: string;
  time: number;
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  mimeType?: string;
  error?: string;
  time: number;
}

export interface Screenshot {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  /** The image's size in pixels. */
  width: number;
  height: number;
  /**
   * Image pixels per CSS pixel of the page. Click coordinates are CSS
   * pixels of the viewport: divide image coordinates by this.
   */
  scale: number;
}

export type ClickTarget = { ref: string } | { x: number; y: number };

export class CdpDriver {
  revision = 0;
  readonly console = new Ring<ConsoleEntry>();
  readonly network = new Ring<NetworkEntry>();
  refs = new Map<number, string>();
  nodes = new Map<string, number>();
  nextRef = 1;
  private disposed = false;
  domEnabled = false;
  dialogOpen = false;
  pick?: {
    resolve(backendNodeId: number | undefined): void;
  };

  constructor(
    private dbg: DebuggerLike,
    public hooks: CdpHooks = {},
  ) {
    dbg.on("message", (_event, method, params) => this.message(method, params));
    dbg.on("detach", (_event, reason) => {
      this.domEnabled = false;
      this.pick?.resolve(undefined);
      this.pick = undefined;
      // The page's target is gone when the tab closes; anything else (a
      // crash, another client) attaches again for the next call.
      if (this.disposed || reason === "target closed") return;
      setTimeout(() => {
        if (!this.disposed) void this.attach().catch(() => {});
      }, 100).unref?.();
    });
  }

  /** Attaches and turns on the events the logs and dialogs need. */
  async attach() {
    if (this.disposed) throw new Error("This tab is closed.");
    if (!this.dbg.isAttached()) this.dbg.attach("1.3");
    await Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("Log.enable"),
      this.send("Network.enable", {
        maxTotalBufferSize: 1_000_000,
        maxResourceBufferSize: 100_000,
      }),
    ]);
  }

  dispose() {
    this.revision++;
    this.disposed = true;
    this.pick?.resolve(undefined);
    this.pick = undefined;
    try {
      if (this.dbg.isAttached()) this.dbg.detach();
    } catch {
      // Already gone with the page.
    }
  }

  async ready() {
    if (!this.dbg.isAttached()) await this.attach();
  }

  /** One command, failing after 15 seconds instead of waiting on a stuck page. */
  async send<T = any>(method: string, params?: object): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.dbg.sendCommand(method, params) as Promise<T>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The page did not respond in time.")),
            commandTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether a confirm/prompt dialog is waiting. */
  get dialogWaiting() {
    return this.dialogOpen;
  }

  refFor = (backendNodeId: number) => {
    const known = this.refs.get(backendNodeId);
    if (known) return known;
    const ref = `ref_${this.nextRef++}`;
    this.refs.set(backendNodeId, ref);
    this.nodes.set(ref, backendNodeId);
    return ref;
  };

  nodeOf(ref: string) {
    const node = this.nodes.get(ref);
    if (node === undefined)
      throw new Error(
        `${ref} isn't on this page any more. Read the page again for new refs.`,
      );
    return node;
  }

  /** The accessibility snapshot (`read_page`), optionally under one ref. */
  async snapshot(
    options: {
      ref?: string;
      interactiveOnly?: boolean;
      maxChars?: number;
    } = {},
  ) {
    await this.waitForDocument();
    const rootBackendId = options.ref ? this.nodeOf(options.ref) : undefined;
    const tree = await this.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
    );
    return formatAXTree(tree.nodes ?? [], this.refFor, {
      interactiveOnly: options.interactiveOnly,
      maxChars: options.maxChars,
      rootBackendId,
    });
  }

  /** Snapshot lines that mention `query` (case-insensitive), at most 20. */
  async find(query: string) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const lines = (await this.snapshot({ maxChars: 400_000 })).split("\n");
    return lines
      .filter((line) => line.toLowerCase().includes(needle))
      .map((line) => line.trim())
      .slice(0, 20);
  }

  /** The page's readable text (the main content when it has one). */
  async text(maxChars = 50_000) {
    await this.waitForDocument();
    const result = await this.send("Runtime.evaluate", {
      expression: pageText,
      returnByValue: true,
    });
    const value = String(result?.result?.value ?? "");
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}\n… (the text is longer)`
      : value;
  }

  /** Runs `expression` in the page; the result as JSON text (at most 20 KB). */
  async evaluate(expression: string) {
    await this.ready();
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 10_000,
    });
    if (result?.exceptionDetails)
      throw new Error(
        clip(
          String(
            result.exceptionDetails.exception?.description ??
              result.exceptionDetails.text ??
              "The script failed.",
          ),
          2000,
        ),
      );
    const value = result?.result?.value;
    const json =
      value === undefined
        ? String(result?.result?.description ?? "undefined")
        : JSON.stringify(value);
    return clip(json ?? "undefined", 20_000);
  }

  async viewportSize() {
    const metrics = await this.send("Page.getLayoutMetrics");
    const view = metrics?.cssVisualViewport ?? metrics?.layoutViewport ?? {};
    const content = metrics?.cssContentSize ?? metrics?.contentSize ?? {};
    return {
      width: Math.max(1, Math.round(view.clientWidth ?? 1)),
      height: Math.max(1, Math.round(view.clientHeight ?? 1)),
      pageX: Math.round(view.pageX ?? 0),
      pageY: Math.round(view.pageY ?? 0),
      contentWidth: Math.max(1, Math.round(content.width ?? 1)),
      contentHeight: Math.max(1, Math.round(content.height ?? 1)),
    };
  }

  async devicePixelRatio() {
    const result = await this.send("Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    });
    const ratio = Number(result?.result?.value);
    return ratio > 0 ? ratio : 1;
  }

  /** Whether Select element is waiting for a click. */
  get picking() {
    return !!this.pick;
  }
}

export interface CdpDriver {
  inspectElement: OmitThisParameter<typeof cdpInspect.inspectElement>;
  pickElement: OmitThisParameter<typeof cdpInspect.pickElement>;
  cancelPick: OmitThisParameter<typeof cdpInspect.cancelPick>;
}
installMethods(CdpDriver.prototype, cdpInspect);

export interface CdpDriver {
  screenshot: OmitThisParameter<typeof cdpInput.screenshot>;
  box: OmitThisParameter<typeof cdpInput.box>;
  point: OmitThisParameter<typeof cdpInput.point>;
  click: OmitThisParameter<typeof cdpInput.click>;
  hover: OmitThisParameter<typeof cdpInput.hover>;
  scroll: OmitThisParameter<typeof cdpInput.scroll>;
  type: OmitThisParameter<typeof cdpInput.type>;
  key: OmitThisParameter<typeof cdpInput.key>;
  objectOf: OmitThisParameter<typeof cdpInput.objectOf>;
  callOn: OmitThisParameter<typeof cdpInput.callOn>;
  setValue: OmitThisParameter<typeof cdpInput.setValue>;
  fieldKind: OmitThisParameter<typeof cdpInput.fieldKind>;
  focusedIsPassword: OmitThisParameter<typeof cdpInput.focusedIsPassword>;
  setViewport: OmitThisParameter<typeof cdpInput.setViewport>;
  setColorScheme: OmitThisParameter<typeof cdpInput.setColorScheme>;
}
installMethods(CdpDriver.prototype, cdpInput);

export interface CdpDriver {
  message: OmitThisParameter<typeof cdpEvents.message>;
  answerDialog: OmitThisParameter<typeof cdpEvents.answerDialog>;
  waitForDocument: OmitThisParameter<typeof cdpEvents.waitForDocument>;
}
installMethods(CdpDriver.prototype, cdpEvents);
