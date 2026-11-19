import { officialAccountMenuGate, officialAccountMenuMessages } from "../../shared/official-account-menu";
import { officialRemoteCodeGate, officialRemoteCodeTransportGates } from "../../shared/official-remote-code";
import { currentLocale, setLocale, t } from "../../src/i18n";
import { createCodeDraftRecovery } from "./code-draft-recovery";
import type { OfficialCodeShellAdapter } from "./code-terminal";
import { bindOfficialAccountStorage, seedOfficialComposerLayout } from "./account-storage";
import { migrateOfficialAccountStorage } from "./legacy-account-storage";
import { mcpAppSandboxPath, officialUserContentOrigin } from "../../shared/official-usercontent-origin";
import { codePreviewFrameUrl } from "../../shared/official-code-preview";
import { conversationListsChanged } from "../../shared/conversation-list-updates";
import { officialSignOutPath } from "./account-fetch";
import { createOfficialReadFetch } from "./read-fetch";
import { createOfficialEventSource } from "./event-source";
import { browserEnv } from "../bridge/browser-env";
import { createGeneratedFileBatch } from "./generated-file-batch";
import { officialRoute, type OfficialFrameBindings } from "./frame-lifecycle";
import { officialCodeHistoryRequest, officialCodeMarkRead, officialCodeReadBody } from "../../shared/official-code-history";
import type { OfficialCodeQueueInput } from "../../shared/official-code-followup";
import { interruptTargetSchema, type InterruptTarget } from "../../shared/interrupt-target";
import { createOfficialChatUpload } from "./chat-upload";
import { isOfficialUiFileReadPath, officialConnectorAuthTarget } from "../../shared/official-ui-web";
import { createOfficialCodeWorkspace } from "./code-workspace";
import { installOfficialShareClipboard, readOfficialShareAddress } from "./share-link";
import { officialShareId } from "../../shared/official-share-link";
import { officialDesignWorkspaceDestination } from "../../shared/official-design-artifacts";
import { productFeedbackText, type ProductFeedbackAnswer } from "../../shared/product-feedback";
import { readStartupPaint, startupSections, type StartupSection } from "./startup-paint";
declare const __OFFICIAL_ENTRY__: string;
declare const __OFFICIAL_LOCALE_LOADER__: string;

function preloadOriginalLocale(locale: string, fetch: typeof window.fetch, signal: AbortSignal) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="i18n-catalogs"]');
  const version = meta?.dataset.i18nCatalogs?.split(",").map((value) => /^([\w-]+):([\w-]+)\.([\w-]+)$/.exec(value))
    .find((value) => value?.[1] === locale);
  const base = version ? `/i18n/${meta?.dataset.i18nCut ?? ""}${locale}.json?v=${version[2]}` : `/i18n/${locale}.json`;
  const dynamic = version ? `/i18n/dynamic/${locale}.json?v=${version[3]}` : `/i18n/dynamic/${locale}.json`;
  const preloaded = window.parent.__claudexLocalePreload;
  const responses = Object.fromEntries([base, dynamic].map((url) => [
      url,
      preloaded?.locale === locale && Object.hasOwn(preloaded.responses, url)
        ? preloaded.responses[url].then(response => response.clone())
        : fetch(url, { signal, ...(version ? { cache: "force-cache" } : {}) }).catch(() => Response.error()),
  ]));
  const bodies = Object.fromEntries([base, dynamic].map(url => {
    const body = preloaded?.locale === locale && preloaded.bodies?.[url] ||
      responses[url].then(response => response.ok ? response.clone().json() : undefined);
    void body.catch(() => {});
    return [url, body];
  }));
  window.__I18N_CATALOG_PRELOAD__ = { locale, responses, bodies };
}
type QueueState = OfficialCodeQueueInput["state"];
type QueueMessage = Record<string, unknown> & { uuid: string; claudexQueueState: QueueState };
type QueueInventory = { uuid: string; state: QueueState }[];
declare global {
  interface Window {
    __claudexLocalePreload?: { locale: string; responses: Record<string, Promise<Response>>; bodies?: Record<string, Promise<unknown>> };
    __I18N_CATALOG_PRELOAD__?: { locale: string; responses: Record<string, Promise<Response>>; bodies?: Record<string, Promise<unknown>> };
    __claudexOfficialDictation?: OfficialFrameBindings["dictation"];
    __claudexOfficialAccountContext?: Readonly<{
      orgUuid: string;
      accountUuid: string;
      sessionMarker?: string;
      requestNotificationPermission?: OfficialFrameBindings["requestNotificationPermission"];
      signOutCurrentSession(): void;
      revokeAllSessions(): void;
      isCodeInputProcessed(sessionId: string, uuid: string): boolean;
      subscribeCodeInputReceipts(listener: () => void): () => void;
      subscribeCodeQueue(listener: (sessionId: string, messages: QueueMessage[]) => void): () => void;
      codeStopTarget(sessionId: string, promptUuid?: string): InterruptTarget | undefined;
      codePreviewUrl(token: string, path: string): string | undefined;
      codePreviewAvailable: boolean;
      codeTerminal?: {
        forSession(sessionId: string): OfficialCodeShellAdapter | undefined;
        stop(sessionId: string, key: string): void;
      };
    }>;
    __claudexConversationListsRevision?: number;
    __claudexGeneratedFileBatch?: ReturnType<typeof createGeneratedFileBatch>;
    __claudexOfficialChatUpload?: ReturnType<typeof createOfficialChatUpload>;
    __claudexOfficialChatImagePath?: (address?: string) => string | undefined;
    __claudexTakeConfirmedCodeDraft?: (key: string) => boolean;
    __claudexCodeWorkspace?: ReturnType<typeof createOfficialCodeWorkspace>;
    __claudexOfficialFrameBindings?: (
      frame: Window,
      document: Document,
    ) => OfficialFrameBindings | undefined;
  }
}
/** Every iframe reload returns through this handshake; no auth session lives here. */
export async function startOfficialFrame() {
  performance.mark("claudex:frame-start");
  if (
    window.parent === window ||
    window.parent.location.origin !== location.origin
  )
    throw Error("An authenticated Claudex host is required.");
  const bindings = window.parent.__claudexOfficialFrameBindings?.(window, document);
  if (!bindings?.isCurrent())
    throw Error("The official frame is not authorized.");
  const nativeFetch = window.fetch.bind(window),
    abort = new window.AbortController();
  let closed = false;
  const subscriptions = new Set<() => void>();
  const codeReceipts = new EventTarget();
  const processedCodeInputs = new Set<string>();
  const codeQueues = new Map<string, { inventory: string; messages: QueueMessage[] }>();
  const codeStopTargets = new Map<string, { target: InterruptTarget; promptUuid?: string } | null>();
  const codeReadRevisions = new Map<string, number>();
  const codeReadEvents = new Map<string, { id: string; revision: number }>();
  const observeCodeSession = (row: { id?: string; claudex_read_revision?: number }) => {
    const key = /^session_([a-f0-9]{32})$/.exec(row?.id ?? "")?.[1];
    const revision = row?.claudex_read_revision;
    if (key && typeof revision === "number" && Number.isSafeInteger(revision) &&
        revision >= (codeReadRevisions.get(key) ?? 0))
      codeReadRevisions.set(key, revision);
  };
  const inputKey = (sessionId: string, uuid: string) =>
    sessionId.replace(/^(session|cse)_/, "") + ":" + uuid;
  const recoverQueue = async (key: string, inventory: QueueInventory, organization?: string) => {
    const state = JSON.stringify(inventory);
    const previous = codeQueues.get(key);
    if (previous?.inventory === state) return;
    const cached = new Map(previous?.messages.map((message) => [message.uuid, message]));
    const next = { inventory: state, messages: [] as QueueMessage[] };
    codeQueues.set(key, next);
    const current = () => !closed && bindings.isCurrent() && codeQueues.get(key) === next;
    const sessionId = `session_${key}`;
    try {
      for (const { uuid, state } of inventory) {
        if (!current()) return;
        const saved = cached.get(uuid);
        if (saved) {
          next.messages.push({ ...saved, claudexQueueState: state });
          continue;
        }
        const answer = await bindings.read({
          method: "GET",
          path: `/v1/code/sessions/${sessionId}/events/queue/${uuid}`,
          ...(organization ? { codeOrganizationId: organization } : {}),
        });
        if (answer.status === 404) continue;
        if (answer.status !== 200) throw Error("Queued Code input is unavailable.");
        const message = JSON.parse(new TextDecoder().decode(answer.body));
        if (message?.type !== "user" || message.uuid !== uuid)
          throw Error("Invalid queued Code input.");
        next.messages.push(message);
      }
      if (current()) codeReceipts.dispatchEvent(new CustomEvent("queue", {
        detail: { sessionId, messages: next.messages },
      }));
    } catch {
      if (current()) codeQueues.delete(key);
    }
  };
  const read: typeof bindings.read = async (request) => {
    const answer = await bindings.read(request);
    if (closed || !bindings.isCurrent() || answer.status !== 200 || request.method !== "GET") return answer;
    if ((bindings.apiManagement || bindings.serviceStatus || bindings.announcements || bindings.zecousMigration || bindings.dispatch) && request.path === "/api/account") {
      const account = JSON.parse(new TextDecoder().decode(answer.body));
      if (bindings.apiManagement) account.claudex_api_management = true;
      if (bindings.serviceStatus) account.claudex_service_status = true;
      if (bindings.announcements) account.claudex_service_announcements = true;
      if (bindings.dispatch) account.claudex_dispatch = true;
      if (bindings.cloudEnvironments?.listRemoteCodeEnvironments) account.claudex_remote_code = true;
      if (bindings.zecousMigration) account.claudex_zecous_migration = true;
      return { ...answer, body: new TextEncoder().encode(JSON.stringify(account)) };
    }
    if (/^\/(?:api|edge-api)\/bootstrap(?:\/[^/]+\/app_start)?(?:\?|$)/.test(request.path)) {
      const bootstrap = JSON.parse(new TextDecoder().decode(answer.body));
      if (bindings.apiManagement && bootstrap.account) bootstrap.account.claudex_api_management = true;
      if (bindings.serviceStatus && bootstrap.account) bootstrap.account.claudex_service_status = true;
      if (bindings.announcements && bootstrap.account) bootstrap.account.claudex_service_announcements = true;
      if (bindings.dispatch && bootstrap.account) bootstrap.account.claudex_dispatch = true;
      if (bindings.cloudEnvironments?.listRemoteCodeEnvironments && bootstrap.account)
        bootstrap.account.claudex_remote_code = true;
      if (bindings.zecousMigration && bootstrap.account) bootstrap.account.claudex_zecous_migration = true;
      for (const growthbook of [bootstrap.growthbook, bootstrap.org_growthbook]) {
        if (growthbook?.features) {
          growthbook.features[officialAccountMenuGate] = { defaultValue: true };
          growthbook.features[officialRemoteCodeGate] = {
            defaultValue: !!bindings.cloudEnvironments?.listRemoteCodeEnvironments,
          };
          if (bindings.cloudEnvironments?.listRemoteCodeEnvironments)
            Object.assign(growthbook.features, officialRemoteCodeTransportGates);
        }
      }
      const gated = bootstrap.gated_messages;
      if (typeof gated?.locale === "string" && currentLocale() !== gated.locale)
        await setLocale(gated.locale, { persist: false, document: false });
      if (closed || !bindings.isCurrent()) return answer;
      bootstrap.gated_messages = {
        ...gated,
        messages: { ...officialAccountMenuMessages(t), ...gated?.messages },
        gates: [...new Set([...(gated?.gates ?? []), `__gb__${officialAccountMenuGate}`])],
      };
      return { ...answer, body: new TextEncoder().encode(JSON.stringify(bootstrap)) };
    }
    if (!request.path.startsWith("/v1/code/sessions")) return answer;
    const url = new URL(request.path, location.origin);
    const history = officialCodeHistoryRequest(request.method, url.pathname, url.search);
    if (!history || history.kind === "queue" || history.kind === "teleport") return answer;
    try {
      const { data, queue, session, claudex_read_event: readEvent, pinned_beyond_page: pinned } =
        JSON.parse(new TextDecoder().decode(answer.body));
      if (history.kind === "list") {
        data?.forEach(observeCodeSession);
        pinned?.sessions?.forEach(observeCodeSession);
        return answer;
      }
      if (session) observeCodeSession(session);
      if (typeof readEvent?.id === "string" && Number.isSafeInteger(readEvent.revision) &&
          readEvent.revision >= (codeReadEvents.get(history.key)?.revision ?? 0))
        codeReadEvents.set(history.key, readEvent);
      if (session?.id === `session_${history.key}` &&
          (history.kind === "stream" || !codeStopTargets.has(history.key))) {
        const stop = session.claudex_stop_target;
        const target = interruptTargetSchema.safeParse(stop?.target);
        codeStopTargets.set(history.key, target.success ? {
          target: target.data,
          promptUuid: typeof stop.promptUuid === "string" ? stop.promptUuid : undefined,
        } : null);
      }
      if (Array.isArray(queue) && queue.every((entry) =>
        typeof entry?.uuid === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.uuid) &&
        ["queued", "held", "sending", "unknown"].includes(entry.state)))
        void recoverQueue(history.key, queue, request.codeOrganizationId);
      if (!Array.isArray(data)) return answer;
      let changed = false;
      for (const event of data) {
        const payload = event?.payload;
        if (typeof payload?.uuid !== "string") continue;
        const uuid = payload.type === "user" && typeof event.processing_at === "string"
          ? payload.uuid
          : payload.type === "result" && payload.uuid.endsWith(":result")
            ? payload.uuid.slice(0, -7) : undefined;
        if (!uuid) continue;
        const key = inputKey(history.key, uuid);
        if (processedCodeInputs.has(key)) continue;
        if (processedCodeInputs.size >= 5000) {
          const oldest = processedCodeInputs.values().next().value;
          if (oldest) processedCodeInputs.delete(oldest);
        }
        processedCodeInputs.add(key);
        changed = true;
      }
      if (changed) codeReceipts.dispatchEvent(new Event("change"));
    } catch {
      // The original consumer still handles the response.
    }
    return answer;
  };
  const action: typeof bindings.action = (request, transfer) => {
    if (request.body && !transfer?.private) {
      let savedTemporary: unknown;
      try { savedTemporary = JSON.parse(sessionStorage.getItem("incognito_temporary_conversation_uuid") ?? "null"); }
      catch { /* The URL remains authoritative for an explicit temporary route. */ }
      const routeId = /^\/chat\/([a-f0-9-]{36})$/i.exec(location.pathname)?.[1];
      if (new URLSearchParams(location.search).has("incognito") ||
          routeId && savedTemporary && typeof savedTemporary === "object" &&
          "uuid" in savedTemporary && savedTemporary.uuid === routeId)
        transfer = { ...transfer, signal: transfer?.signal ?? abort.signal, private: true };
    }
    const key = officialCodeMarkRead(request.method, request.path);
    if (key && request.body) {
      try {
        const { event_id: eventId } = officialCodeReadBody.parse(
          JSON.parse(new TextDecoder().decode(request.body)),
        );
        const observed = codeReadEvents.get(key);
        const revision = eventId
          ? observed?.id === eventId ? observed.revision : undefined
          : codeReadRevisions.get(key);
        if (revision !== undefined) return bindings.action({ ...request, codeReadRevision: revision }, transfer);
      } catch {
        // The Runner validates the original request body.
      }
    }
    return bindings.action(request, transfer);
  };
  let drafts: ReturnType<typeof createCodeDraftRecovery> | undefined;
  window.addEventListener("beforeunload", () => drafts?.leave());
  document.addEventListener("input", (event) => {
    if (event.isTrusted && event.target instanceof Element &&
        event.target.closest('[data-testid="code-prompt-input"]')) drafts?.edited();
  }, true);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    for (const off of subscriptions) {
      try { off(); } catch { /* revoke all subscriptions */ }
    }
    subscriptions.clear();
  };
  const subscribe = (
    listener: Parameters<OfficialFrameBindings["events"]>[0],
  ) => {
    if (closed) throw Error("The frame has closed.");
    let active = true;
    let off = () => {};
    const close = () => {
      if (!active) return;
      active = false;
      try { off(); } finally { subscriptions.delete(close); }
    };
    subscriptions.add(close);
    try {
      off = bindings.events((event) => {
        // Revoke before a potentially throwing consumer can interrupt cleanup.
        if (event.type === "signed-out") cleanup();
        listener(event);
      });
      // Some event sources synchronously revoke while registering.
      if (!active) off();
    } catch (error) {
      close();
      throw error;
    }
    return close;
  };
  window.addEventListener("pagehide", () => {
    drafts?.leave();
    cleanup();
    bindings.onDocumentExit();
  }, { once: true });
  try {
    if (bindings.dictation) Object.defineProperty(window, "__claudexOfficialDictation", {
      value: Object.freeze(bindings.dictation),
    });
    // Retain list changes received before the original query observer mounts.
    let listRevision = 0;
    window.__claudexConversationListsRevision = listRevision;
    const listsChanged = conversationListsChanged({ cloudCode: true });
    subscribe((event) => {
      if (closed || !bindings.isCurrent() || !listsChanged(event)) return;
      window.__claudexConversationListsRevision = ++listRevision;
      window.dispatchEvent(new window.Event("claudex:conversation-lists-invalidated"));
    });
    if (document.documentElement.dataset.buildId !== "79979f1379" ||
        !document.getElementById("root") || !document.getElementById("portal-root"))
      throw Error("The official document failed its build contract.");
    let account: {
      uuid?: string;
      settings?: { locale?: string };
      claudex_composer_layout_seed?: unknown;
      memberships?: { organization?: { uuid?: string; capabilities?: string[] } }[];
    } = bindings.startupIdentity ?? {};
    if (!bindings.startupIdentity) {
      const response = await bindings.read({ method: "GET", path: "/api/account" });
      if (response.status !== 200) throw Error("The current Chat organization is unavailable.");
      account = JSON.parse(new TextDecoder().decode(response.body));
    }
    performance.mark("claudex:frame-account");
    const organization = account?.memberships?.find(
      (membership) => membership.organization?.capabilities?.includes("chat"),
    )?.organization?.uuid;
    if (typeof account?.uuid !== "string" || !account.uuid ||
        typeof organization !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organization))
      throw Error("The current Chat organization is unavailable.");
    if (closed || !bindings.isCurrent())
      throw new DOMException("The account changed.", "AbortError");
    window.fetch = createOfficialReadFetch(
      location.origin,
      read,
      nativeFetch,
      subscribe,
      action,
      bindings.account,
      (path, bytes) => drafts?.remember(path, bytes),
      { organization, githubStatus: bindings.githubStatus, githubConnect: bindings.githubConnect,
        githubDisconnect: bindings.githubDisconnect, githubBranches: bindings.githubBranches,
        githubRepositories: bindings.githubRepositories,
        cloudEnvironments: bindings.cloudEnvironments && { accountUuid: account.uuid, api: bindings.cloudEnvironments },
        codeStreamConnected: bindings.codeStreamConnected, sharedChatSnapshotId: bindings.sharedChatSnapshotId },
      abort.signal,
      { api: bindings.apiManagement, serviceStatus: bindings.serviceStatus, announcements: bindings.announcements, dispatch: bindings.dispatch, zecousMigration: bindings.zecousMigration, notificationPreferences: bindings.notificationPreferences, current: () => !closed && bindings.isCurrent() },
    );
    const coworkMemoryPath = `/v1/environment_providers/private/organizations/${organization}/users/me/memory?repo=cowork`;
    Object.defineProperty(window, "__claudexHostedCoworkMemoryReady", {
      value: window.fetch(coworkMemoryPath, { signal: abort.signal })
        .then(response => response.ok, () => false),
    });
    installOfficialShareClipboard({
      clipboard: navigator.clipboard,
      clipboardItem: window.ClipboardItem,
      origin: location.origin,
      resolve: (id) => readOfficialShareAddress(bindings.read, id, location.origin),
    });
    const nativeOpen = window.open.bind(window);
    const parseAddress = (address?: string | URL) =>
      address && URL.canParse(address, location.href) ? new URL(address, location.href) : undefined;
    const designWorkspaceDestination = (url?: URL) => {
      if (!url || closed || !bindings.isCurrent()) return;
      return officialDesignWorkspaceDestination(url, location.origin);
    };
    const openShare = (address: string | URL | undefined) => {
      if (address === undefined || !URL.canParse(address, location.href)) return false;
      const id = officialShareId(new URL(address, location.href), location.origin, true);
      if (!id || closed || !bindings.isCurrent()) return false;
      void browserEnv().openTab(readOfficialShareAddress(bindings.read, id, location.origin)).catch(() => {});
      return true;
    };
    window.open = (address, target, features) => {
      if (target === "_blank" && openShare(address)) return null;
      const url = parseAddress(address);
      const design = target === "_blank" && designWorkspaceDestination(url);
      if (design) return nativeOpen(design, target, "noopener,noreferrer");
      const auth = url?.origin === location.origin && officialConnectorAuthTarget("GET", url.pathname + url.search);
      if (target !== "mcp-auth" || !url || !auth || auth.kind !== "start" || auth.organizationId !== organization)
        return nativeOpen(address, target, features);
      if (closed || !bindings.isCurrent()) return null;
      const popup = nativeOpen("about:blank", target, features);
      if (!popup) return null;
      url.searchParams.set("response_format", "json");
      void window.fetch(url, { signal: abort.signal }).then(async (response) => {
        if (!response.ok || closed || !bindings.isCurrent()) throw Error("Connector sign-in failed.");
        const result = await response.json();
        if (result.connected === true) { popup.close(); return; }
        const destination = URL.parse(result.auth_url);
        if (!destination || destination.protocol !== "https:" || destination.username || destination.password)
          throw Error("Connector sign-in failed.");
        if (!popup.closed && !closed && bindings.isCurrent()) popup.location.replace(destination.href);
      }).catch(() => popup.close());
      return popup;
    };
    const openBlankLink = (event: MouseEvent) => {
      if (event.type === "auxclick" && event.button !== 1) return;
      const link = event.target instanceof Element && event.target.closest("a[target='_blank']");
      if (!(link instanceof HTMLAnchorElement) || event.defaultPrevented) return;
      const design = designWorkspaceDestination(parseAddress(link.href));
      if (design) {
        event.preventDefault();
        nativeOpen(design, "_blank", "noopener,noreferrer");
      } else if (event.type === "click" && openShare(link.href)) {
        event.preventDefault();
      }
    };
    window.addEventListener("click", openBlankLink, { signal: abort.signal });
    window.addEventListener("auxclick", openBlankLink, { signal: abort.signal });
    window.EventSource = createOfficialEventSource(
      location.origin,
      bindings.read,
      window.EventSource,
      subscribe,
    );
    window.__claudexOfficialChatUpload = createOfficialChatUpload({
      origin: location.origin, organization, signal: abort.signal, action,
    });
    window.__claudexOfficialChatImagePath = (address) => {
      if (!address || closed || !bindings.isCurrent()) return;
      const url = new URL(address, location.origin);
      if (url.origin === location.origin && !url.search && !url.hash &&
          [ `/api/${organization}/files/`, `/api/organizations/${organization}/files/` ].some((prefix) => url.pathname.startsWith(prefix)) &&
          /\/(?:preview|thumbnail)$/.test(url.pathname) && isOfficialUiFileReadPath(url.pathname))
        return url.pathname;
    };
    const push = history.pushState.bind(history),
      replace = history.replaceState.bind(history);
    const navigate =
      (method: typeof push, replacing: boolean) =>
      (data: unknown, unused: string, url?: string | URL | null) => {
        if (url == null) {
          method(data, unused, url);
          return;
        }
        const destination = new URL(String(url), location.href);
        if (destination.origin === location.origin && destination.pathname === "/login" &&
            destination.searchParams.get("add_account") === "1" && bindings.isCurrent()) {
          let email: string | undefined;
          try {
            const saved: unknown = JSON.parse(sessionStorage.getItem("addAccountSignInAgainEmail") ?? "null");
            if (saved && typeof saved === "object" && "email" in saved && typeof saved.email === "string")
              email = saved.email;
            sessionStorage.removeItem("addAccountSignInAgainEmail");
          } catch {}
          void bindings.account.addAccount(email);
          return;
        }
        const route = officialRoute(destination.href, location.origin);
        if (officialSignOutPath(destination.pathname)) {
          bindings.onNavigate(route, replacing);
          return;
        }
        method(data, unused, route);
        bindings.onNavigate(route, replacing);
      };
    history.pushState = navigate(push, false);
    history.replaceState = navigate(replace, true);
    replace(null, "", officialRoute(bindings.route, location.origin));
    window.addEventListener("popstate", () => {
      if (bindings.isCurrent())
        bindings.onNavigate(
          location.pathname + location.search + location.hash,
          true,
        );
    });
    if (closed || !bindings.isCurrent())
      throw new DOMException("The account changed.", "AbortError");
    const contentOrigin = officialUserContentOrigin(bindings.userContentOrigin, location.origin);
    const openBilling = bindings.openBilling;
    if (openBilling)
      Object.defineProperty(window, "__claudexBilling", {
        value: async (trigger: unknown) =>
          !closed && bindings.isCurrent() && trigger instanceof HTMLElement && openBilling(trigger),
      });
    const exportAccountData = bindings.exportAccountData;
    if (exportAccountData)
      Object.defineProperty(window, "__claudexAccountExport", {
        value: Object.freeze({
          scope: "service",
          save: (...args: Parameters<typeof exportAccountData>) =>
            exportAccountData(...args).then((file) => typeof file === "string"),
        }),
      });
    const submitProductFeedback = bindings.submitProductFeedback;
    if (submitProductFeedback) {
      const current = () => !closed && bindings.isCurrent();
      const unavailable = { failureReason: "unavailable", statusCode: 403 };
      const submit = async (form: unknown): Promise<ProductFeedbackAnswer> => {
        if (!current()) return unavailable;
        const text = productFeedbackText(form);
        return typeof text === "string" ? submitProductFeedback(text) : text;
      };
      const submitCode = async (sessionId: unknown, description: unknown, signal?: AbortSignal): Promise<ProductFeedbackAnswer> => {
        const key = typeof sessionId === "string" && /^(?:session|cse)_([a-f0-9]{32})$/.exec(sessionId)?.[1];
        const routeKey = /^\/code\/(?:session|cse)_([a-f0-9]{32})\/?$/.exec(location.pathname)?.[1];
        if (!current() || signal?.aborted || !key || key !== routeKey || typeof description !== "string") return unavailable;
        const answer = await read({ method: "GET", path: `/v1/code/sessions/session_${key}`, codeOrganizationId: organization });
        if (!current() || signal?.aborted || answer.status !== 200) return unavailable;
        const { session } = JSON.parse(new TextDecoder().decode(answer.body));
        if (session?.id !== `session_${key}` || session.started_by_account_id !== account.uuid ||
          !Number.isSafeInteger(session.claudex_read_revision)) return unavailable;
        const stillSelected = /^\/code\/(?:session|cse)_([a-f0-9]{32})\/?$/.exec(location.pathname)?.[1] === key;
        if (!stillSelected) return unavailable;
        return submitProductFeedback(description);
      };
      Object.defineProperty(window, "__claudexProductFeedback", { value: Object.freeze({ version: 1, submit, submitCode }) });
    }
    Object.defineProperty(window, "__claudexOfficialAccountContext", {
      value: Object.freeze({
        orgUuid: organization,
        accountUuid: account.uuid,
        sessionMarker: bindings.sessionMarker,
        requestNotificationPermission: bindings.requestNotificationPermission,
        signOutCurrentSession: () => {
          if (!closed && bindings.isCurrent()) bindings.onNavigate("/logout", false);
        },
        revokeAllSessions: () => {
          if (!closed && bindings.isCurrent()) bindings.onNavigate("/logout/all-sessions", false);
        },
        codeTerminal: bindings.codeTerminal && Object.freeze({
          forSession: (sessionId: string) => bindings.codeTerminal?.forSession(sessionId, organization),
          stop: (sessionId: string, key: string) => bindings.codeTerminal?.stop(sessionId, key),
        }),
        codePreviewAvailable: contentOrigin !== undefined &&
          !!codePreviewFrameUrl(contentOrigin, "1-00000000000000000000000000000000", "/"),
        codePreviewUrl: (token: string, path: string) =>
          !closed && bindings.isCurrent() && contentOrigin
            ? codePreviewFrameUrl(contentOrigin, token, path) : undefined,
        isCodeInputProcessed: (sessionId: string, uuid: string) =>
          !closed && bindings.isCurrent() && processedCodeInputs.has(inputKey(sessionId, uuid)),
        codeStopTarget(sessionId: string, promptUuid?: string) {
          if (closed || !bindings.isCurrent()) return;
          const stop = codeStopTargets.get(sessionId.replace(/^(session|cse)_/, ""));
          if (stop && (!promptUuid || !stop.promptUuid || promptUuid === stop.promptUuid))
            return stop.target;
        },
        subscribeCodeInputReceipts(listener: () => void) {
          codeReceipts.addEventListener("change", listener);
          return () => codeReceipts.removeEventListener("change", listener);
        },
        subscribeCodeQueue(listener: (sessionId: string, messages: QueueMessage[]) => void) {
          const receive = (event: Event) => {
            const { sessionId, messages } = (event as CustomEvent<{ sessionId: string; messages: QueueMessage[] }>).detail;
            listener(sessionId, messages);
          };
          codeReceipts.addEventListener("queue", receive);
          return () => codeReceipts.removeEventListener("queue", receive);
        },
      }),
    });
    Object.defineProperty(window, "__claudexCodeWorkspace", {
      value: createOfficialCodeWorkspace({
        fetch: window.fetch,
        organization,
        current: () => !closed && bindings.isCurrent(),
        signal: abort.signal,
      }),
    });
    const unavailablePreview = new URL("/official-preview-unavailable.html", location.origin).href;
    Object.defineProperty(window, "__claudexOfficialUserContentOrigin", {
      value: contentOrigin ?? unavailablePreview,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(window, "__claudexMcpAppsSandboxUrl", {
      value: contentOrigin ? contentOrigin + mcpAppSandboxPath : unavailablePreview,
    });
    window.__claudexGeneratedFileBatch = createGeneratedFileBatch({
      organization,
      fetch: window.fetch,
      download: browserEnv().download,
      current: bindings.isCurrent,
      signal: abort.signal,
    });
    const owner = account.uuid;
    const source = { localStorage: window.localStorage, indexedDB: window.indexedDB };
    const releaseStorage = bindOfficialAccountStorage(window, account.uuid, (key, value) => {
      drafts?.trackWrite(key, value);
      if (key === "LSS-userThemeMode" && !closed && bindings.isCurrent()) applyTheme(value);
    });
    const locale = bindings.startupIdentity
      ? window.localStorage.getItem("spa:account-locale") ?? account.settings?.locale
      : account.settings?.locale;
    if (locale && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(locale)) {
      try {
        window.localStorage.setItem("spa:locale", locale);
        window.localStorage.setItem("spa:account-locale", locale);
      } catch {}
      document.documentElement.lang = locale;
      if (locale !== "en-US") preloadOriginalLocale(locale, nativeFetch, abort.signal);
    }
    const draftRecovery = createCodeDraftRecovery({ localStorage: window.localStorage, sessionStorage: window.sessionStorage });
    drafts = draftRecovery;
    const applyTheme = (raw: string | null) => {
      let theme: unknown;
      try { theme = JSON.parse(raw ?? "null"); } catch { theme = raw; }
      if (theme && typeof theme === "object" && "value" in theme) theme = theme.value;
      const host = window.parent.document.documentElement;
      if (theme === "light" || theme === "dark") {
        host.dataset.theme = theme;
        document.documentElement.dataset.mode = theme;
      } else {
        delete host.dataset.theme;
        document.documentElement.dataset.mode =
          window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    };
    applyTheme(window.localStorage.getItem("LSS-userThemeMode"));
    subscriptions.add(releaseStorage);
    const migrationSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]);
    const migrate = () => migrateOfficialAccountStorage({
      source,
      target: { localStorage: window.localStorage, indexedDB: window.indexedDB },
      owner,
      organization,
      signal: migrationSignal,
      current: () => !closed && bindings.isCurrent(),
    });
    const prepareStorage = async () => {
      try {
        if (navigator.locks) {
          await navigator.locks.request(
            `claudex:official-migration:${owner}`,
            { signal: migrationSignal },
            migrate,
          );
        } else await migrate();
      } catch {
        // An unavailable store can be retried on the next visit.
      }
      await draftRecovery.reconcile(bindings.read, () => !closed && bindings.isCurrent());
      performance.mark("claudex:frame-storage");
    };
    const loadLocale = async () => {
      if (!window.__I18N_CATALOG_PRELOAD__) return;
      const loader = await import(/* @vite-ignore */ __OFFICIAL_LOCALE_LOADER__);
      await loader.Uo(window.__I18N_CATALOG_PRELOAD__.locale);
      performance.mark("claudex:frame-locale");
    };
    await Promise.all([
      prepareStorage(),
      loadLocale(),
      document.fonts.load('500 20px anthropic-serif', 'Claudex'),
    ]);
    performance.mark("claudex:frame-resources");
    if (closed || !bindings.isCurrent())
      throw new DOMException("The account changed.", "AbortError");
    try {
      seedOfficialComposerLayout(window.localStorage, account.claudex_composer_layout_seed);
    } catch {
      // Accessing storage itself can fail in restricted browser contexts.
    }
    Object.defineProperty(window, "__claudexTakeConfirmedCodeDraft", {
      value: (key: string) => !closed && bindings.isCurrent() && drafts?.takeConfirmed(key) === true,
    });
    const parentRoot = window.parent.document.documentElement;
    if (parentRoot.hasAttribute("data-official-home-boot")) {
      document.documentElement.dataset.claudexHomeStartup = "";
      const ready = new Set<StartupSection>();
      let lastLayout = "";
      const reveal = () => {
        if (closed || !bindings.isCurrent() || !parentRoot.hasAttribute("data-official-home-boot")) {
          stop();
          return;
        }
        const bootResult = document.documentElement.dataset.bootUiReady;
        const rail = window.parent.document.getElementById("official-home-boot-rail");
        const paint = readStartupPaint(document, parentRoot.dataset.officialBootRoute === "chat",
          !rail || window.parent.getComputedStyle(rail).display === "none");
        const before = ready.size;
        for (const section of paint.ready) ready.add(section);
        if (bootResult === "error" || bootResult === "timeout")
          for (const section of startupSections) ready.add(section);
        const layout = `${paint.sidebarWidth}:${paint.composerTop}`;
        if (ready.size !== before || layout !== lastLayout) {
          lastLayout = layout;
          window.parent.postMessage({ ...paint, ready: [...ready] }, location.origin);
        }
        if (ready.size === startupSections.length) {
          stop();
          requestAnimationFrame(() => window.parent.postMessage("claudex:official-home-painted", location.origin));
        }
      };
      const observer = new MutationObserver(reveal);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-boot-ui-ready", "class", "style", "hidden", "aria-hidden"] });
      document.addEventListener("animationend", reveal, true);
      document.addEventListener("transitionend", reveal, true);
      const stop = () => {
        observer.disconnect();
        document.removeEventListener("animationend", reveal, true);
        document.removeEventListener("transitionend", reveal, true);
      };
      subscriptions.add(stop);
      reveal();
    }
    performance.mark("claudex:frame-import");
    await import(/* @vite-ignore */ __OFFICIAL_ENTRY__);
    performance.mark("claudex:frame-imported");
  } catch (error) {
    cleanup();
    throw error;
  }
}
