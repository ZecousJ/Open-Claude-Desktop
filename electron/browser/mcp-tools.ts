import { type SiteRisk } from "./site-risk";
import { type BrowserPolicy } from "../../shared/client-policy";
import {
  type BrowserNavigateResult,
  type BrowserState,
  type BrowserTabState,
  type BrowserViewport,
  normalizeAddress,
} from "../../shared/browser";
import type { CdpDriver } from "./cdp";
import type { DevServersPort } from "./index";
import {
  type ElicitRequest,
  type McpCallContext,
  type McpCallResult,
  type McpHandlers,
  type McpTool,
} from "./mcp-server";
import { SitePermissions, siteKey } from "./site-permissions";
import {
  pageTools,
  scriptTool,
  devServerTools,
} from "./browser-tool-definitions";
import { schemas, ToolName, ToolError, ok, failed } from "./browser-tool-args";
import {
  siteQuestion,
  fileOfUrl,
  insideFolder,
  fileQuestion,
  devServerQuestion,
} from "./browser-tool-questions";
import { browserToolsInstructions } from "./browser-tools-registration";
import * as mcpToolsRun from "./mcp-tools-run";
import { installMethods } from "./install-methods";

/** The Codex MCP server name; its tools show as `claudex_browser.<tool>`. */
export const browserMcpServerName = "claudex_browser";
/** The app-server variable that carries the bearer token (never written to config.toml). */
export const browserMcpTokenEnv = "CLAUDEX_BROWSER_MCP_TOKEN";
/** The approval form's one field: "once" or "always". */
export const approvalDecisionField = "decision";

// ---------------------------------------------------------------------------
// What the tools use

/** The page driver calls the tools make (`CdpDriver`, R8-A). */
export type BrowserDriver = Pick<
  CdpDriver,
  | "snapshot"
  | "find"
  | "text"
  | "evaluate"
  | "screenshot"
  | "click"
  | "hover"
  | "scroll"
  | "type"
  | "key"
  | "setValue"
  | "fieldKind"
  | "focusedIsPassword"
  | "send"
  | "console"
  | "network"
>;

/** The Browser panel calls the tools make (`BrowserHost`, R8-A). */
export interface BrowserToolsHost {
  state(conversationId: string): BrowserState;
  navigate(
    conversationId: string,
    input: string,
    tabId?: string,
  ): BrowserNavigateResult;
  newTab(conversationId: string, url?: string, foreground?: boolean): string;
  selectTab(conversationId: string, tabId: string): void;
  closeTab(conversationId: string, tabId: string): void;
  back(conversationId: string): void;
  forward(conversationId: string): void;
  reload(conversationId: string): void;
  setViewport(conversationId: string, viewport: BrowserViewport): Promise<void>;
  answerDialog(
    conversationId: string,
    tabId: string,
    accept: boolean,
    text?: string,
  ): Promise<void>;
  driver(
    conversationId: string,
    tabId?: string,
  ): {
    tabId: string;
    driver: BrowserDriver;
    url: string;
    state: BrowserTabState;
  };
}

export interface BrowserToolsService {
  readonly host: BrowserToolsHost;
  devServers(): DevServersPort | undefined;
}

export interface BrowserToolsDeps {
  siteRisk?(url: string): Promise<SiteRisk>;
  /** The account's Browser service (created on first use). */
  service(): Promise<BrowserToolsService>;
  permissions: SitePermissions;
  /** The administrator's Browser policy now (defaults filled in). */
  policy(): BrowserPolicy;
  /** Browser tools on in Settings and allowed by the administrator. */
  toolsAvailable(): boolean;
  /** "Always allow" may be offered (policy approvalsAlwaysAllow). */
  alwaysAllowOffered(): boolean;
  /** A scheduled task runs the conversation: nobody can approve anything. */
  unattended(conversationId: string): boolean;
  /** The conversation exists and is a Code session on this computer. */
  codeConversation(conversationId: string): boolean;
  /** The conversation's project folder (a file page inside it opens without asking). */
  folderOf?(conversationId: string): string | undefined;
  /** How long `navigate` waits for a page (30 s). */
  loadTimeoutMs?: number;
  /** Claude opened a page: the session's window shows its Browser panel. */
  reveal?(conversationId: string): void;
  sleep?(ms: number): Promise<void>;
}

export { privateNetworkHost } from "./site-risk";

// ---------------------------------------------------------------------------
// The tools

export class BrowserTools implements McpHandlers {
  /** Questions in flight, so parallel calls on one site ask once. */
  private asking = new Map<string, Promise<string | undefined>>();
  private approvedRoutineRevision = new WeakMap<McpCallContext, number>();
  private routineCalls = new WeakMap<McpCallContext, string>();
  private approvedSites = new WeakMap<McpCallContext, Set<string>>();
  private siteChecked(call: McpCallContext, url?: string) {
    if (url) {
      const sites = this.approvedSites.get(call) ?? new Set<string>();
      sites.add(JSON.stringify(siteKey(url)));
      this.approvedSites.set(call, sites);
    }
    const revision = this.deps.permissions.routine(
      call.conversationId,
    )?.revision;
    if (revision !== undefined)
      this.approvedRoutineRevision.set(call, revision);
    return revision;
  }

  constructor(public deps: BrowserToolsDeps) {}

  tools(): McpTool[] {
    const policy = this.deps.policy();
    return [
      ...pageTools,
      ...(policy.allowScript === false ? [] : [scriptTool]),
      ...(policy.devServers === false ? [] : devServerTools),
    ];
  }

  instructions() {
    return browserToolsInstructions;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    call: McpCallContext,
  ): Promise<McpCallResult> {
    const id = call.conversationId;
    if (!this.deps.toolsAvailable())
      return failed("Browser tools are turned off.");
    if (!this.deps.codeConversation(id))
      return failed("The browser is only in Code sessions on this computer.");
    if (!(name in schemas)) return failed(`Unknown tool: ${name}.`);
    try {
      const routine = this.deps.permissions.routine(id);
      if (routine) this.routineCalls.set(call, routine.taskId);
      this.siteChecked(call);
      const result = await this.run(name as ToolName, args, call);
      this.assertExecution(id, call);
      if (
        this.approvedRoutineRevision.get(call) !==
        this.deps.permissions.routine(id)?.revision
      )
        throw new ToolError("Browser approval is required again.");
      return result;
    } catch (error) {
      return failed(
        error instanceof Error && error.message
          ? error.message
          : "The browser action failed.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Pages and sites

  assertExecution(id: string, call?: McpCallContext) {
    const expected = call && this.routineCalls.get(call);
    const routine = this.deps.permissions.routine(id);
    if (
      (expected && (routine?.taskId !== expected || !routine.active)) ||
      !this.deps.toolsAvailable() ||
      !this.deps.codeConversation(id) ||
      this.deps.permissions.routine(id)?.active === false
    )
      throw new ToolError(
        "Browser tools are unavailable in this conversation.",
      );
  }
  assertNavigation(id: string, url: string, call?: McpCallContext) {
    this.assertExecution(id, call);
    const decision = this.deps.permissions.decide(id, url);
    if (decision.access === "deny") throw new ToolError(decision.message);
    const once =
      call &&
      this.approvedSites.get(call)?.has(JSON.stringify(siteKey(url))) &&
      this.approvedRoutineRevision.get(call) ===
        this.deps.permissions.routine(id)?.revision;
    if (
      this.deps.permissions.routine(id) &&
      decision.access !== "allow" &&
      !once
    )
      throw new ToolError("Browser approval is required again.");
  }
  knownTab(host: BrowserToolsHost, id: string, tab: string) {
    if (!host.state(id).tabs.some((value) => value.id === tab))
      throw new ToolError(`There's no tab ${tab}. Use tabs_list.`);
  }

  /** The page a tool acts on, after checking Claude may use its site. */
  async page(
    service: BrowserToolsService,
    call: McpCallContext,
    tabId?: string,
  ) {
    if (tabId) this.knownTab(service.host, call.conversationId, tabId);
    const page = service.host.driver(call.conversationId, tabId);
    if (!page.url)
      throw new ToolError("The tab is blank. Open a page with navigate first.");
    if (page.state.error)
      throw new ToolError(
        `The page couldn't be loaded (${page.state.error.description}).`,
      );
    if (page.state.crashed)
      throw new ToolError("The page crashed. Reload it with navigate.");
    const approvedGrant = await this.ensureSite(call, page.url);
    // A page in the hidden parking window (panel closed, window in the
    // background) never has focus, so clicks would not focus fields and
    // typing would go nowhere; the page is told it has focus.
    await page.driver
      .send("Emulation.setFocusEmulationEnabled", { enabled: true })
      .catch(() => {});
    const check = () => {
      this.assertExecution(call.conversationId, call);
      const current = service.host.driver(call.conversationId, page.tabId);
      const decision = this.deps.permissions.decide(
        call.conversationId,
        current.url,
      );
      if (
        !this.deps.toolsAvailable() ||
        !this.deps.codeConversation(call.conversationId) ||
        decision.access === "deny" ||
        siteKey(current.url).kind !== siteKey(page.url).kind ||
        new URL(current.url).origin !== new URL(page.url).origin ||
        (this.deps.permissions.routine(call.conversationId) &&
          approvedGrant !==
            this.deps.permissions.routine(call.conversationId)?.revision)
      )
        throw new ToolError(
          decision.access === "deny"
            ? decision.message
            : "Browser approval is required again.",
        );
    };
    // No re-elicitation after an approval is revoked during a call. Read
    // results are discarded; multi-step actions recheck before each driver call.
    const driver = new Proxy(page.driver, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        return async (...args: unknown[]) => {
          check();
          const result = await member.apply(target, args);
          check();
          return result;
        };
      },
    });
    check();
    return { ...page, driver };
  }

  /**
   * Checks Claude may use the site of `url`, asking the person when needed;
   * throws with the reason when not.
   */
  private async ensureSite(call: McpCallContext, url: string) {
    const id = call.conversationId;
    const decision = this.deps.permissions.decide(id, url);
    const risk =
      /^https?:/.test(url) &&
      decision.access !== "deny" &&
      !(
        decision.access === "allow" &&
        ["blank", "local"].includes(decision.reason)
      )
        ? await this.deps.siteRisk?.(url)
        : undefined;
    if (risk === "blocked")
      throw new ToolError(
        "This site can’t be added due to safety restrictions.",
      );
    // Risk checks are asynchronous: a revocation or owner change while they
    // run must take effect before any page action.
    const current = this.deps.permissions.decide(id, url);
    this.assertExecution(id, call);
    if (!this.deps.toolsAvailable() || !this.deps.codeConversation(id))
      throw new ToolError(
        "Browser tools are unavailable in this conversation.",
      );
    if (current.access === "deny") throw new ToolError(current.message);
    if (
      decision.access === "allow" &&
      current.access === "allow" &&
      risk !== "high-risk"
    )
      return this.siteChecked(call, url);
    // A file in the project folder opens without asking (the original's
    // browser:open_file asks only for files outside it).
    const file = fileOfUrl(url);
    const folder = this.deps.folderOf?.(id);
    if (
      decision.access === "ask" &&
      file &&
      folder &&
      insideFolder(folder, file)
    )
      return this.siteChecked(call, url);
    if (decision.access === "deny") throw new ToolError(decision.message);
    if (this.deps.unattended(id) && !this.deps.permissions.routine(id)?.active)
      throw new ToolError(
        `Using ${decision.origin} needs the person's approval, and scheduled tasks can't ask. Add it to Allowed sites in Settings → Claudex Code → Browser.`,
      );
    if (!call.canElicit)
      throw new ToolError(
        `Using ${decision.origin} needs the person's approval, which can't be asked here.`,
      );
    const key = `${id}\n${decision.origin}`;
    let pending = this.asking.get(key);
    if (!pending) {
      const canAlways =
        decision.access === "ask" &&
        decision.canAlwaysAllow &&
        risk !== "high-risk" &&
        this.deps.alwaysAllowOffered();
      pending = call
        .elicit(
          file
            ? fileQuestion(file)
            : siteQuestion(decision.origin, canAlways, risk),
        )
        .then((answer) => {
          this.assertExecution(id, call);
          if (answer.action !== "accept")
            return `The person didn't allow Claudex to use ${decision.origin}.`;
          if (
            !this.deps.toolsAvailable() ||
            !this.deps.codeConversation(id) ||
            this.deps.permissions.decide(id, url).access === "deny"
          )
            return "Browser tools are unavailable in this conversation.";
          const always =
            canAlways && answer.content?.[approvalDecisionField] === "always";
          if (
            risk !== "high-risk" &&
            (!always || !this.deps.permissions.remember(id, decision.origin))
          )
            this.deps.permissions.grant(id, decision.origin);
          return undefined;
        })
        .finally(() => this.asking.delete(key));
      this.asking.set(key, pending);
    }
    const refusal = await pending;
    if (refusal) throw new ToolError(refusal);
    // The site may have been turned off meanwhile (policy).
    const again = this.deps.permissions.decide(id, url);
    if (again.access === "deny") throw new ToolError(again.message);
    return this.siteChecked(call, url);
  }

  /** Approvals that are never remembered (password fields, scripts). */
  async askEveryTime(call: McpCallContext, request: ElicitRequest) {
    if (this.deps.unattended(call.conversationId))
      throw new ToolError(
        "This needs the person's approval, and scheduled tasks can't ask.",
      );
    if (!call.canElicit)
      throw new ToolError(
        "This needs the person's approval, which can't be asked here.",
      );
    const answer = await call.elicit(request);
    if (answer.action !== "accept")
      throw new ToolError("The person didn't allow it.");
  }

  /** What `url` opens, after the site check (the address bar's rules). */
  async addressFor(call: McpCallContext, input: string) {
    const text = input.trim();
    // Files the person opened stay theirs: the panel checks the folder.
    const address = /^file:/i.test(text)
      ? ({ ok: true, url: text } as const)
      : normalizeAddress(text);
    if (!address.ok) throw new ToolError(address.message);
    await this.ensureSite(call, address.url);
    return address.url;
  }

  async navigate(
    service: BrowserToolsService,
    call: McpCallContext,
    args: { url: string; tabId?: string },
  ): Promise<McpCallResult> {
    const id = call.conversationId;
    const host = service.host;
    const word = args.url.trim().toLowerCase();
    if (word === "back" || word === "forward" || word === "reload") {
      if (this.deps.permissions.routine(id)) {
        if (word !== "reload")
          throw new ToolError(
            "Use an approved website address to navigate this scheduled run.",
          );
        const tab = host
          .state(id)
          .tabs.find(
            (value) => value.id === (args.tabId ?? host.state(id).activeTabId),
          );
        this.assertNavigation(id, tab?.url ?? "", call);
      }
      const state = host.state(id);
      if (args.tabId && args.tabId !== state.activeTabId)
        host.selectTab(id, args.tabId);
      if (word === "back") host.back(id);
      else if (word === "forward") host.forward(id);
      else host.reload(id);
      const tab = host.state(id).activeTabId!;
      await this.waitForLoad(host, id, tab);
      return ok(
        this.pageSummary(
          host,
          id,
          tab,
          word === "reload" ? "Reloaded" : "Now on",
          call,
        ),
      );
    }
    if (args.tabId) this.knownTab(host, id, args.tabId);
    const url = await this.addressFor(call, args.url);
    this.assertExecution(id, call);
    this.assertNavigation(id, url, call);
    const result = host.navigate(id, url, args.tabId);
    if (!result.ok) throw new ToolError(result.message);
    this.deps.reveal?.(id);
    const tab = args.tabId ?? host.state(id).activeTabId!;
    await this.waitForLoad(host, id, tab);
    return ok(this.pageSummary(host, id, tab, "Opened", call));
  }

  /**
   * Waits for the tab to finish loading (at most `loadTimeoutMs`): the load
   * starts a moment after the call, so a tab that never showed loading is
   * given a second.
   */
  async waitForLoad(host: BrowserToolsHost, id: string, tabId: string) {
    const sleep =
      this.deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const started = Date.now();
    const limit = this.deps.loadTimeoutMs ?? 30_000;
    let sawLoading = false;
    for (;;) {
      const tab = host.state(id).tabs.find((value) => value.id === tabId);
      if (!tab) return;
      if (tab.loading) sawLoading = true;
      const elapsed = Date.now() - started;
      if (tab.error || tab.crashed || tab.dialog || tab.stalled) return;
      if (!tab.loading && (sawLoading || elapsed >= 1000)) return;
      if (elapsed >= limit) return;
      await sleep(100);
    }
  }

  pageSummary(
    host: BrowserToolsHost,
    id: string,
    tabId: string,
    verb: string,
    call?: McpCallContext,
  ) {
    const tab = host.state(id).tabs.find((value) => value.id === tabId);
    if (!tab) return `${verb} the page.`;
    this.assertNavigation(id, tab.url, call);
    if (tab.error)
      return `${tab.error.url || tab.url} couldn't be loaded: ${tab.error.description} (${tabId}).`;
    if (tab.crashed) return `The page crashed (${tabId}).`;
    const parts = [
      `${verb} ${tab.url || "a blank page"} (${tabId})${tab.title ? ` — ${JSON.stringify(tab.title)}` : ""}.`,
    ];
    if (tab.loading)
      parts.push(
        tab.stalled
          ? "The page arrived but hasn't finished loading."
          : "The page is still loading.",
      );
    if (tab.dialog)
      parts.push(
        `The page shows a ${tab.dialog.type} dialog: ${JSON.stringify(tab.dialog.message)}. Answer it with handle_dialog.`,
      );
    return parts.join(" ");
  }

  // -------------------------------------------------------------------------
  // Dev servers

  devServers(service: BrowserToolsService): DevServersPort {
    const port = service.devServers();
    if (!port || this.deps.policy().devServers === false)
      throw new ToolError("Dev servers aren't available here.");
    return port;
  }

  async previewStart(
    service: BrowserToolsService,
    call: McpCallContext,
    name: string,
  ): Promise<McpCallResult> {
    const id = call.conversationId;
    const port = this.devServers(service);
    if (this.deps.unattended(id))
      throw new ToolError("Dev servers can't be started from scheduled tasks.");
    if (port.needsApproval?.(id, name) && !call.canElicit)
      throw new ToolError(
        `Starting "${name}" needs the person's approval, which can't be asked here. They can start it from the Browser panel.`,
      );
    const state = await port.start(id, name, {
      by: "claude",
      approve: async (request) => {
        const answer = await call.elicit(devServerQuestion(request));
        return answer.action === "accept";
      },
    });
    if (state.status !== "running")
      return failed(
        `${name} didn't start: ${(state.error ?? state.status).replace(/\.$/, "")}. Read its output with preview_logs.`,
      );
    if (!state.url) return ok(`${name} is running.`);
    // Open it where the person looks: the shown tab when blank, else a new tab.
    const host = service.host;
    const browser = host.state(id);
    const shown = browser.tabs.find((tab) => tab.id === browser.activeTabId);
    let tab: string;
    if (shown && !shown.url) {
      const result = host.navigate(id, state.url, shown.id);
      if (!result.ok)
        return ok(`${name} is running at ${state.url}. ${result.message}`);
      tab = shown.id;
    } else tab = host.newTab(id, state.url, true);
    this.deps.reveal?.(id);
    await this.waitForLoad(host, id, tab);
    return ok(
      `${name} is running at ${state.url}. ${this.pageSummary(host, id, tab, "Opened", call)}`,
    );
  }
}

export interface BrowserTools {
  run: OmitThisParameter<typeof mcpToolsRun.run>;
}
installMethods(BrowserTools.prototype, mcpToolsRun);
