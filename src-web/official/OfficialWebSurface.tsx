import { bootstrapRead, preloadBootstrapCatalog } from "./bootstrap-read";
import { isChatStartupPath, readStartupIdentity, rememberStartupIdentity } from "./startup-identity";
import { isStartupPaint } from "./startup-paint";
import { parseOfficialCapabilityPreferenceRequest } from "../../shared/official-capability-preferences";
import { officialConnectorAuthTarget, officialSpendLimitActionOrganization } from "../../shared/official-ui-web";
import { parseOfficialConnectorPreference } from "../../shared/official-connector-preferences";
import { parseOfficialModelFallbackRequest } from "../../shared/official-model-fallback";
import { parseOfficialCodeSettingsRequest } from "../../shared/official-code-settings";
import {officialUserContentOrigin} from "../../shared/official-usercontent-origin";
import {negotiatedAppearanceSettings} from './negotiated-appearance-action';
import {isOfficialAppearanceAction} from '../../shared/official-appearance-capability';
import {negotiatedMemoryAction} from './negotiated-memory-action';
import { officialMelangeEditRequest } from "../../shared/official-melange";
import {officialMemoryAction} from '../../shared/official-memory-capability';
import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../src/i18n";
import { showToast } from "../../src/ui/toast-store";
import { ArrowLeft } from "../../src/ui/glyphs";
import { lazyPiece } from "../../src/ui/lazy-piece";
import { hasEscapeLayer } from "../../src/ui/useDismiss";
import { BootErrorPage } from "../../src/boot/BootErrorPage";
import type { AuthenticatedAppProps } from "../../src/app/AuthGate";
import type { WebBridge } from "../bridge";
import type { OfficialUiCapabilities } from "../../shared/official-ui-web";
import { parseGitHubReturn, type GitHubAPI } from "../../shared/github-api";
import { createOfficialCodeTerminals } from "./code-terminal";
import { createOfficialFrameDocumentGate } from "./frame-document-gate";
import { negotiatedOfficialAction, readOfficialCapabilities } from "./negotiated-action";
import { officialAccountActivation, officialBrowserAccounts } from "../../shared/official-account-menu";
import { officialSignOutPath, type OfficialSignOut } from "./account-fetch";
import { forgetOfficialAccountDrafts } from "./account-storage";
import { bindOfficialFrame, officialRoute } from "./frame-lifecycle";
import { officialCoworkMemory } from "../../shared/official-cowork-memory";
import { officialSharedChatReadPath, officialSharedChatToken, readOfficialSharedChatSnapshot } from "./shared-chat";
import { remoteCodeLinkTarget } from "../../shared/official-remote-code";
import { askNotificationPermission } from "../../src/app/web-notifications";
import { createOfficialNotificationPreferences } from "./notification-preferences";
import { subscribeOfficialNotifications } from "./notifications";
import { browserEnv } from "../bridge/browser-env";
import { createOfficialWebDictation } from "./dictation";
import type { BlankArtifact } from "../../shared/blank-artifacts";
import { isOwnedDesign, officialDesignArtifactRoute } from "../../shared/official-design-artifacts";
import type { AppEvent, Conversation } from "../../shared/types";
import { deferFileTransition } from "../../src/files/file-transitions";
import { mergeConversationTurn } from "../../src/host/events";

const BillingView = lazyPiece(() => import("../../src/checkout-window/BillingView"));
const BlankDesignCanvas = lazyPiece(() => import("../../src/artifacts/BlankDesignCanvas"), "BlankDesignCanvas");
const publicShareRoute = /^\/(?:share|shared)(?:\/|$)/;
const artifactGalleryRoute = /^\/artifacts(?:\/design)?\/?$/;

type BillingPanel = {
  id: string;
  route: string;
  email: string;
  trigger: HTMLElement;
  back: () => void;
};
type DesignConversation = Conversation & { blankArtifact: BlankArtifact };
type DesignEvent = Extract<AppEvent, { type: "conversation" | "conversation-turn" }>;
type DesignPanel = {
  route: string;
  fromGallery: boolean;
  conversation: DesignConversation;
  owner: object | undefined;
  isCurrent: () => boolean;
  back: () => void;
};

const officialAccountOrganization = (value: unknown) => {
  if (!value || typeof value !== "object" || !("memberships" in value) || !Array.isArray(value.memberships))
    return undefined;
  for (const membership of value.memberships as unknown[]) {
    if (!membership || typeof membership !== "object" || !("organization" in membership)) continue;
    const candidate = membership.organization;
    if (!candidate || typeof candidate !== "object" || !("uuid" in candidate) ||
        typeof candidate.uuid !== "string" || !("capabilities" in candidate) ||
        !Array.isArray(candidate.capabilities) || !candidate.capabilities.includes("chat")) continue;
    return candidate.uuid;
  }
};
function officialAccountId(answer: Awaited<ReturnType<WebBridge["officialUiRead"]>>) {
  if (answer.status !== 200) throw Error("The account is unavailable.");
  const account: unknown = JSON.parse(new TextDecoder().decode(answer.body));
  if (!account || typeof account !== "object" || !("uuid" in account) ||
      typeof account.uuid !== "string" || !account.uuid)
    throw Error("The account is unavailable.");
  return account.uuid;
}

export function OfficialWebSurface({
  bridge,
  accountId,
  onSignOut,
  onSignOutEverywhere,
  chatActionMode = "read-only",
  memoryControlsOptIn = false,
  appearanceSettingsOptIn = false,
  userContentOrigin,
}: AuthenticatedAppProps & { bridge: WebBridge; chatActionMode?: OfficialUiCapabilities["mode"]; memoryControlsOptIn?: boolean; appearanceSettingsOptIn?: boolean; userContentOrigin?: string }) {
  const signOut = useRef({ current: onSignOut, all: onSignOutEverywhere });
  signOut.current = { current: onSignOut, all: onSignOutEverywhere };
  const frame = useRef<HTMLIFrameElement>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<unknown>();
  const [billing, setBilling] = useState<BillingPanel>();
  const [design, setDesign] = useState<DesignPanel>();
  const billingBack = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (billing) billingBack.current?.focus();
  }, [billing]);
  const [revoked, setRevoked] = useState(false);
  const [callbackPending, setCallbackPending] = useState(() => location.pathname === "/mcp/oauth/callback");
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.officialWorkspace = "";
    return () => {
      delete root.dataset.officialWorkspace;
      delete root.dataset.theme;
      delete root.dataset.officialHomeBoot;
    };
  }, [accountId]);
  useLayoutEffect(() => {
    if (location.pathname !== "/code") return;
    const url = new URL(location.href);
    const result = parseGitHubReturn(url.searchParams.get("github"));
    if (!result) return;
    url.searchParams.delete("github");
    history.replaceState(history.state, "", url);
    if (result === "denied")
      showToast(t("The GitHub authorization was canceled or didn’t go through. You can try again, or pick up where you left off."), { variant: "danger" });
    if (result === "failed")
      showToast(t("Something went wrong while connecting to GitHub. You can try again, or pick up where you left off."), { variant: "danger" });
  }, []);
  useLayoutEffect(() => {
    if (location.pathname !== "/mcp/oauth/callback") return;
    const params = new URLSearchParams(location.search);
    const state = params.get("state");
    const code = params.get("code");
    const issuer = params.get("iss");
    const providerError = params.get("error");
    const key = "claudex:mcp-auth:" + state;
    let attempt: { accountId: string; organizationId: string; serverId: string; returnRoute: string; expires: number } | undefined;
    try {
      const saved = localStorage.getItem(key);
      if (saved) attempt = JSON.parse(saved);
      localStorage.removeItem(key);
    } catch {}
    if (!state || !attempt || attempt.accountId !== accountId || attempt.expires <= Date.now()) {
      history.replaceState(null, "", "/");
      window.close();
      if (!window.closed) setCallbackPending(false);
      return;
    }
    const { serverId, organizationId: organization, returnRoute } = attempt;
    history.replaceState(null, "", officialRoute(returnRoute, location.origin));
    let active = true;
    const activation = bridge.auth.activationIdentity;
    const current = () => active && activation !== undefined && bridge.auth.activationIdentity === activation && bridge.auth.current?.account.id === accountId;
    void (async () => {
      if (!current() || chatActionMode !== "engine-chat") throw Error("Connector sign-in failed.");
      const capability = await readOfficialCapabilities(bridge.officialUiRead, accountId);
      if (!current() || capability.mode !== "engine-chat" || capability.textChat.state !== "ready") throw Error("Connector sign-in failed.");
      const callback = providerError
        ? { state, error: providerError === "access_denied" ? providerError : "authorization_failed" }
        : { state, code, ...(issuer && { iss: issuer }) };
      const answer = await bridge.officialUiAction({ method: "POST", path: `/api/organizations/${organization}/mcp/complete-auth/${serverId}`,
        contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(callback)), capabilityLease: capability.activationLease });
      if (!current() || answer.status !== (providerError ? 204 : 200)) throw Error("Connector sign-in failed.");
      const channel = new BroadcastChannel("mcp-auth-channel");
      channel.postMessage({ type: "mcp-auth-complete", step: providerError ? "error" : "success", serverId,
        ...(providerError && { oauthError: callback.error }) });
      channel.close();
      window.close();
      if (!window.closed) setCallbackPending(false);
    })().catch(() => {
      if (!current()) return;
      const channel = new BroadcastChannel("mcp-auth-channel");
      channel.postMessage({ type: "mcp-auth-complete", step: "error", serverId });
      channel.close();
      window.close();
      if (!window.closed) setCallbackPending(false);
    });
    return () => { active = false; };
  }, [bridge, accountId, chatActionMode]);
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node || revoked || error || callbackPending) return;
    if (location.pathname === "/login") history.replaceState(null, "", "/new");
    const token = officialSharedChatToken(location.pathname);
    const sharedChat = token ? { token, id: crypto.randomUUID(), pathname: location.pathname } : undefined;
    const snapshotPath = sharedChat && `/share/${sharedChat.id}`;
    let active = true;
    const openingActivation = bridge.auth.activationIdentity;
    const activationCurrent = () => openingActivation !== undefined &&
      bridge.auth.activationIdentity === openingActivation && bridge.auth.current?.account.id === accountId;
    const accountCurrent = () => active && activationCurrent();
    const sessionMarker = bridge.auth.current?.sessionId === undefined ? undefined
      : `claudex-${accountId}-${bridge.auth.current.sessionId}`;
    const startupIdentity = isChatStartupPath(location.pathname)
      ? readStartupIdentity(sessionStorage, sessionMarker) : undefined;
    let ownOfficialId = startupIdentity?.uuid;
    const notificationPreferences = !sharedChat && chatActionMode === "engine-chat"
      ? createOfficialNotificationPreferences(bridge.api, accountCurrent)
      : undefined;
    const stopNotifications = notificationPreferences
      ? subscribeOfficialNotifications(bridge, () => ownOfficialId, accountCurrent)
      : undefined;
    const retireNotifications = () => stopNotifications?.();
    window.addEventListener("pagehide", retireNotifications, { once: true });
    const documentGate = createOfficialFrameDocumentGate({
      window: () => node.contentWindow,
      document: () => node.contentDocument,
      url: () => node.contentWindow?.location.href ?? "",
      connected: () => node.isConnected,
    }, location.origin);
    const current = () => accountCurrent() && documentGate.isCurrent();
    const read = bootstrapRead(bridge.officialUiRead, preloadBootstrapCatalog(document, fetch));
    const startupReads = new Map<string, ReturnType<WebBridge["officialUiRead"]>>();
    const bootstrapQuery = "?statsig_hashing_algorithm=djb2&growthbook_format=sdk&cache_bust=1&include_system_prompts=false";
    const startupBootstrapPath = "/edge-api/bootstrap" + bootstrapQuery;
    const chatStartup = isChatStartupPath(location.pathname);
    const mode = new URLSearchParams(location.search).get("mode");
    const startupRoute = location.pathname + location.search;
    if (accountCurrent() && chatStartup && (!mode || mode === "chat")) {
      // These reads need the authenticated activation, but not the frame's modules.
      const bootstrap = read({ method: "GET", path: startupBootstrapPath });
      void bootstrap.catch(() => undefined);
      startupReads.set(startupBootstrapPath, bootstrap);
      const account = bridge.officialUiRead({ method: "GET", path: "/api/account" }).then(answer => {
        if (accountCurrent()) rememberStartupIdentity(sessionStorage, sessionMarker, answer);
        return answer;
      });
      void account.catch(() => undefined);
      startupReads.set("/api/account", account);
    }
    const startupExpires = performance.now() + 10_000;
    let designPanel: DesignPanel | undefined;
    let pendingDesignRead: { route: string; events: DesignEvent[] } | undefined;
    const showDesign = (panel: DesignPanel | undefined) => {
      designPanel = panel;
      setDesign(panel);
    };
    const billingAvailable = () => current() && !publicShareRoute.test(location.pathname);
    let billingEntry: BillingPanel | undefined;
    let billingVisible = false;
    const showBilling = (panel: BillingPanel | undefined) => {
      billingVisible = panel !== undefined;
      setBilling(panel);
    };
    const openBilling = (trigger: HTMLElement) => {
      const account = bridge.auth.current?.account;
      if (!billingAvailable() || !account || trigger.ownerDocument !== node.contentDocument ||
          !trigger.isConnected) return false;
      if (billingVisible) return true;
      const id = crypto.randomUUID();
      billingEntry = {
        id, route: location.href, email: account.email, trigger,
        back: () => {
          if (billingAvailable() && history.state?.claudexBilling === id) history.back();
        },
      };
      history.pushState({ claudexBilling: id }, "");
      showBilling(billingEntry);
      return true;
    };
    const dictation = createOfficialWebDictation({
      env: browserEnv(),
      auth: bridge.auth,
      readAvailability: () => bridge.api.voiceAvailability(),
      isCurrent: () => !sharedChat && current(),
    });
    window.addEventListener("pagehide", dictation.dispose);
    const terminals = chatActionMode === "engine-chat" ? createOfficialCodeTerminals({
      current,
      activationCurrent,
      connected: () => bridge.stream.connected,
      lease: async () => {
        const capability = await readOfficialCapabilities(bridge.officialUiRead, accountId);
        if (capability.mode !== "engine-chat") throw Error("Cloud Code actions are unavailable.");
        return capability.activationLease;
      },
      action: bridge.officialUiAction,
      releaseOnExit: bridge.releaseOfficialCodeTerminal,
      events: bridge.officialUiEvents,
    }) : undefined;
    const releaseTerminals = () => terminals?.dispose();
    window.addEventListener("pagehide", releaseTerminals);
    const assertCurrent = () => {
      if (!current())
        throw new DOMException("The active account changed.", "AbortError");
    };
    const accountOperation = <Args extends unknown[], Result,>(
      operation: (...args: Args) => Promise<Result>,
    ) => async (...args: Args) => {
      assertCurrent();
      const result = await operation(...args);
      assertCurrent();
      return result;
    };
    let organization = officialAccountOrganization(startupIdentity);
    const restartFrame = () => {
      if (!current()) return;
      showDesign(undefined);
      terminals?.dispose();
      dictation.dispose();
      scoped.dispose();
      setVersion(v => v + 1);
    };
    const resolveDesign = () => {
      pendingDesignRead = undefined;
      const account = ownOfficialId;
      const org = organization;
      const url = new URL(location.href);
      const target = officialDesignArtifactRoute(url.pathname, url.search);
      if (!current() || sharedChat || !account || !org || target?.organization !== org) return;
      const route = url.pathname + url.search;
      const fromGallery = history.state?.claudexDesignFromGallery === true;
      const events: DesignEvent[] = [];
      const read = { route, events };
      pendingDesignRead = read;
      void bridge.api.snapshot().then(({ conversations }) => {
        if (pendingDesignRead !== read) return;
        pendingDesignRead = undefined;
        if (!current() || route !== location.pathname + location.search) return;

        let conversation = conversations.find((entry) => entry.blankArtifact?.id === target.id);
        for (const event of events) {
          if (event.type === "conversation") {
            const next = event.conversation;
            if (next.id === conversation?.id || next.blankArtifact?.id === target.id)
              conversation = next;
          } else {
            conversation = mergeConversationTurn(conversation, event) ?? conversation;
          }
        }
        if (!conversation || !isOwnedDesign(conversation, account, org) || conversation.blankArtifact.id !== target.id) {
          showDesign(undefined);
          return;
        }
        showDesign({
          route: route + url.hash, fromGallery, conversation, owner: openingActivation, isCurrent: accountCurrent,
          back: () => {
            if (!current()) return;
            if (fromGallery) history.back();
            else {
              history.replaceState(null, "", "/artifacts");
              restartFrame();
            }
          },
        });
      }).catch(() => {
        if (pendingDesignRead === read) pendingDesignRead = undefined;
      });
    };
    const remoteCode = async (
      request: Parameters<WebBridge["officialUiRead"]>[0],
      fallback: WebBridge["officialUiRead"],
    ) => {
      if (sharedChat || chatActionMode !== "engine-chat") return fallback(request);
      return await bridge.officialRemoteCode.request(request, {
        current: assertCurrent,
        organization,
        hint: remoteCodeLinkTarget(new URL(location.href)),
        fallback: (path = request.path) => fallback({ ...request, path }),
      }) ?? fallback(request);
    };
    const logout = async (scope: OfficialSignOut) => {
      assertCurrent();
      const operation = signOut.current[scope];
      if (!operation) throw Error("Sign out is unavailable.");
      const owner = ownOfficialId;
      await operation();
      if (owner) forgetOfficialAccountDrafts(window, owner);
    };
    let pendingOAuthNavigation: { address: string; expires: number } | undefined;
    const retireDocument = () => {
      if (!active) return;
      const pending = pendingOAuthNavigation;
      pendingOAuthNavigation = undefined;
      if (pending && pending.expires >= Date.now() && current()) {
        location.assign(pending.address);
      }
      terminals?.dispose();
      dictation.dispose();
      documentGate.revoke();
      scoped.dispose();
      active = false;
      showBilling(undefined);
      showDesign(undefined);
      // A new mount starts at the trusted entry, never reuses the old document lease.
      setVersion(v => v + 1);
    };
    const appearanceAction=negotiatedAppearanceSettings({enabled:appearanceSettingsOptIn,accountId,
      current:()=>current()&&openingActivation!==undefined&&bridge.auth.activationIdentity===openingActivation,
      read:bridge.officialUiRead,action:bridge.officialUiAction});
    const memoryAction=negotiatedMemoryAction({enabled:memoryControlsOptIn,accountId,
      current:()=>current()&&openingActivation!==undefined&&bridge.auth.activationIdentity===openingActivation,
      read:bridge.officialUiRead,action:bridge.officialUiAction});
    const chatAction=negotiatedOfficialAction({
          mode: chatActionMode, accountId,
          isCurrent: () => current() && openingActivation !== undefined && bridge.auth.activationIdentity === openingActivation,
          read: bridge.officialUiRead, action: bridge.officialUiAction,
        });
    const scoped = bindOfficialFrame(
      {
        read: async (request) => {
          if (sharedChat && request.method === "GET" && request.path === officialSharedChatReadPath)
            return readOfficialSharedChatSnapshot({ read: bridge.readSharedChat, ...sharedChat });
          if (performance.now() >= startupExpires || startupRoute !== location.pathname + location.search)
            startupReads.clear();
          const startupPath = organization && request.path === `/edge-api/bootstrap/${organization}/app_start${bootstrapQuery}`
            ? startupBootstrapPath : request.path;
          const pending = request.method === "GET" ? startupReads.get(startupPath) : undefined;
          if (pending) {
            startupReads.delete(startupPath);
            const answer = await pending.catch(() => undefined);
            assertCurrent();
            if (answer?.status === 200) return answer;
          }
          return remoteCode(request, read);
        },
        action: async (request, transfer) => {
          if (officialSpendLimitActionOrganization(request.method, request.path)) {
            assertCurrent();
            const answer = await bridge.officialUiAction(request, transfer);
            assertCurrent();
            return answer;
          }
          if (officialCoworkMemory(request.method, request.path))
            return bridge.officialUiAction(request, transfer);
          try {
            if (parseOfficialConnectorPreference(request) || parseOfficialCodeSettingsRequest(request) ||
                parseOfficialModelFallbackRequest(request) || parseOfficialCapabilityPreferenceRequest(request))
              return chatAction(request);
          } catch (error) {
            return { status: 400, contentType: "application/json",
              body: new TextEncoder().encode(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid settings request." })) };
          }
          if (isOfficialAppearanceAction(request.method, request.path)) return appearanceAction(request);
          if (officialMemoryAction(request.method, request.path)) return memoryAction(request, transfer);
          if (officialMelangeEditRequest(request.method, request.path)?.kind === "stop")
            return bridge.officialUiAction(request);
          const answer = await remoteCode(request, (forwarded) => chatAction(forwarded, transfer));
          const connectorAuth = officialConnectorAuthTarget(request.method, request.path);
          if (connectorAuth?.kind === "start" && answer.status === 200 && current()) {
            try {
              const value = JSON.parse(new TextDecoder().decode(answer.body));
              const address = new URL(value.auth_url);
              if (address.protocol === "https:" && !address.username && !address.password && typeof value.state === "string") {
                const params = new URL(request.path, location.origin).searchParams;
                const returnRoute = officialRoute(params.get("redirect_url") ?? "/", location.origin);
                const attemptPrefix = "claudex:mcp-auth:";
                for (const key of Object.keys(localStorage)) {
                  if (!key.startsWith(attemptPrefix)) continue;
                  try {
                    const attempt = JSON.parse(localStorage.getItem(key) ?? "null");
                    if (typeof attempt?.expires === "number" && attempt.expires > Date.now()) continue;
                  } catch {}
                  localStorage.removeItem(key);
                }
                localStorage.setItem(attemptPrefix + value.state, JSON.stringify({
                  accountId, organizationId: connectorAuth.organizationId, serverId: connectorAuth.serverId,
                  returnRoute, expires: Date.now() + 10 * 60_000,
                }));
                pendingOAuthNavigation = { address: address.href, expires: Date.now() + 5000 };
              }
            } catch {}
          }
          return answer;
        },
        events: bridge.officialUiEvents,
      },
      current,
      () => snapshotPath ? snapshotPath + location.search + location.hash : officialRoute(location.href, location.origin),
      (route, replace) => {
        if (!current()) return;
        const url = new URL(officialRoute(route, location.origin), location.origin);
        const scope = officialSignOutPath(url.pathname);
        if (scope) {
          void logout(scope).catch(() => {
            if (current()) showToast(t("Something went wrong. Please try again."), { variant: "danger" });
          });
          return;
        }
        if (designPanel) return;
        const pathname = sharedChat && url.pathname === snapshotPath ? sharedChat.pathname : url.pathname;
        const next = pathname + url.search + url.hash;
        if (next !== location.pathname + location.search + location.hash) {
          delete document.documentElement.dataset.officialHomeBoot;
          const replaceEntry = replace || billingVisible;
          const fromGallery = !replaceEntry && artifactGalleryRoute.test(location.pathname) && !!officialDesignArtifactRoute(pathname, url.search);
          if (billingVisible) showBilling(undefined);
          (replaceEntry ? history.replaceState : history.pushState).call(
            history,
            fromGallery ? { claudexDesignFromGallery: true } : null,
            "",
            next,
          );
          resolveDesign();
        }
      },
      retireDocument,
    );
    let authorizedWindow: Window | undefined;
    const authorize = (child: Window, childDocument: Document) => {
      if (!accountCurrent() || !documentGate.claim(child, childDocument)) return undefined;
      authorizedWindow = child;
      child.addEventListener("pagehide", retireDocument, {once:true});
      if (!sharedChat) void dictation.refresh();
      return {
        ...scoped.bindings,
        sessionMarker,
        startupIdentity,
        dictation: dictation.host,
        apiManagement: !sharedChat && chatActionMode === "engine-chat" ? bridge.api : undefined,
        serviceStatus: !sharedChat ? accountOperation(bridge.api.serviceStatus) : undefined,
        notificationPreferences,
        requestNotificationPermission: notificationPreferences
          ? accountOperation(askNotificationPermission)
          : undefined,
        dispatch: !sharedChat ? {
          status: accountOperation(bridge.dispatch.status),
          tasks: accountOperation(bridge.dispatch.tasks),
          directories: accountOperation(bridge.dispatch.directories),
          deliver: accountOperation(bridge.dispatch.deliver),
          details: accountOperation(bridge.dispatch.details),
          followUp: accountOperation(bridge.dispatch.followUp),
          approve: accountOperation(bridge.dispatch.approve),
          interrupt: accountOperation(bridge.dispatch.interrupt),
          trust: accountOperation(bridge.dispatch.trust),
          retry: accountOperation(bridge.dispatch.retry),
          remove: accountOperation(bridge.dispatch.remove),
        } : undefined,
        announcements: !sharedChat ? {
          notices: accountOperation(bridge.officialAnnouncements.notices),
          pending: accountOperation(bridge.officialAnnouncements.pending),
          markRead: accountOperation(bridge.officialAnnouncements.markRead),
          close: accountOperation(bridge.officialAnnouncements.close),
        } : undefined,
        zecousMigration: !sharedChat ? {
          status: accountOperation(bridge.officialZecousMigration.status),
          confirm: accountOperation(bridge.officialZecousMigration.confirm),
        } : undefined,
        submitProductFeedback: !sharedChat && chatActionMode === "engine-chat" ? accountOperation(bridge.submitProductFeedback) : undefined,
        exportAccountData: !sharedChat ? accountOperation(bridge.api.exportData) : undefined,
        openBilling: billingAvailable() ? openBilling : undefined,
        read: async (request: Parameters<WebBridge["officialUiRead"]>[0]) => {
          const answer = await scoped.bindings.read(request);
          if (request.method === "GET" && request.path === "/api/account" && answer.status === 200) {
            rememberStartupIdentity(sessionStorage, sessionMarker, answer);
            const firstAccountRead = ownOfficialId === undefined;
            ownOfficialId = officialAccountId(answer);
            try {
              localStorage.setItem("claudex:official-owner:" + encodeURIComponent(accountId), ownOfficialId);
            } catch {}
            organization = officialAccountOrganization(JSON.parse(new TextDecoder().decode(answer.body)));
            if (firstAccountRead) resolveDesign();
          }
          return answer;
        },
        sharedChatSnapshotId: sharedChat?.id,
        userContentOrigin: officialUserContentOrigin(userContentOrigin, location.origin),
        codeTerminal: terminals && { forSession: terminals.forSession, stop: terminals.stop },
        codeStreamConnected: (key: string) =>
          bridge.officialRemoteCode.owns(key) || bridge.stream.connected ||
          remoteCodeLinkTarget(new URL(location.href))?.key === key,
        account: {
          activeSessions: accountOperation(() => bridge.activeSessions.activeSessions()),
          endActiveSession: accountOperation((id: string) => bridge.activeSessions.endActiveSession(id)),
          browserAccounts: accountOperation(async () => {
            const accounts = await bridge.auth.browserAccounts();
            return officialBrowserAccounts(accounts, (handle) => handle === accountId ? ownOfficialId ?? null : null);
          }),
          switchAccount: async (handle: string) => {
            assertCurrent();
            const next = await bridge.auth.switchAccount(handle);
            if (bridge.auth.current?.account.id !== next.id)
              throw new DOMException("The active account changed.", "AbortError");
            if (next.id === accountId && ownOfficialId)
              return officialAccountActivation({ id: ownOfficialId });
            const activation = bridge.auth.activationIdentity;
            const id = officialAccountId(await bridge.officialUiRead({ method: "GET", path: "/api/account" }));
            if (bridge.auth.activationIdentity !== activation)
              throw new DOMException("The active account changed.", "AbortError");
            return officialAccountActivation({ id });
          },
          addAccount: (email?: string) => {
            assertCurrent();
            return bridge.auth.addAccount(email);
          },
          signOut: logout,
        },
        githubStatus: accountOperation(bridge.api.githubStatus),
        githubConnect: !sharedChat && chatActionMode === "engine-chat" ? accountOperation(async () => {
          const result = await bridge.api.githubConnect();
          assertCurrent();
          const address = new URL(result.authorizeUrl);
          if (address.origin !== "https://github.com" || address.pathname !== "/login/oauth/authorize" ||
              address.username || address.password)
            throw Error("The service did not return a GitHub authorization address.");
          pendingOAuthNavigation = { address: address.href, expires: Date.now() + 5000 };
          return result;
        }) : undefined,
        githubDisconnect: !sharedChat && chatActionMode === "engine-chat"
          ? accountOperation(bridge.api.githubDisconnect) : undefined,
        githubBranches: async (input: Parameters<GitHubAPI["githubBranches"]>[0]) => {
          if (!current() || bridge.auth.activationIdentity !== openingActivation)
            throw new DOMException("The active account changed.", "AbortError");
          const branches = await bridge.api.githubBranches(input);
          if (!current() || bridge.auth.activationIdentity !== openingActivation)
            throw new DOMException("The active account changed.", "AbortError");
          return branches;
        },
        githubRepositories: async (input?: Parameters<GitHubAPI["githubRepositories"]>[0]) => {
          if (!current() || bridge.auth.activationIdentity !== openingActivation)
            throw new DOMException("The active account changed.", "AbortError");
          const repositories = await bridge.api.githubRepositories(input);
          if (!current() || bridge.auth.activationIdentity !== openingActivation)
            throw new DOMException("The active account changed.", "AbortError");
          return repositories;
        },
        cloudEnvironments: {
          listCloudEnvironments: accountOperation(() => bridge.api.listCloudEnvironments()),
          listRemoteCodeEnvironments: !sharedChat && chatActionMode === "engine-chat"
            ? () => bridge.officialRemoteCode.environments(assertCurrent) : undefined,
          mutations: chatActionMode === "engine-chat" ? {
            saveCloudEnvironment: accountOperation((input: Parameters<WebBridge["api"]["saveCloudEnvironment"]>[0]) =>
              bridge.api.saveCloudEnvironment(input)),
            archiveCloudEnvironment: accountOperation((id: string) => bridge.api.archiveCloudEnvironment(id)),
          } : undefined,
        },
      };
    };
    const loaded = () => {
      // Initial load belongs to the same claimed Document; only replacement retires it.
      if (documentGate.claimed && !documentGate.isCurrent()) retireDocument();
    };
    node.addEventListener("load", loaded);
    const frameError = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== node.contentWindow || !accountCurrent()) return;
      if (isStartupPaint(event.data) && current()) {
        const root = document.documentElement;
        root.dataset.officialBootReady = event.data.ready.join(" ");
        if (event.data.sidebarWidth !== null) {
          const width = Math.max(0, Math.min(node.clientWidth, event.data.sidebarWidth));
          root.style.setProperty("--boot-sidebar-width", `${width}px`);
          root.toggleAttribute("data-boot-sidebar-collapsed", width === 0);
        }
        if (event.data.composerTop !== null)
          root.style.setProperty("--boot-content-bottom", `${Math.max(0, node.clientHeight - event.data.composerTop)}px`);
      }
      if (event.data === "claudex:official-home-painted")
        delete document.documentElement.dataset.officialHomeBoot;
      if (event.data === "claudex:official-frame-load-failed") {
        delete document.documentElement.dataset.officialHomeBoot;
        setError(new Error("Official frame failed to load"));
      }
    };
    window.addEventListener("message", frameError);
    window.__claudexOfficialFrameBindings = authorize;
    const revoke = (restart = false) => {
      if (!active) return;
      delete document.documentElement.dataset.officialHomeBoot;
      terminals?.dispose();
      dictation.dispose();
      active = false;
      showBilling(undefined);
      showDesign(undefined);
      documentGate.revoke();
      scoped.dispose();
      // Clear the old document immediately, then let React own DOM removal.
      node.contentDocument?.body?.replaceChildren();
      node.src = "about:blank";
      if (restart) setVersion(v => v + 1);
      else setRevoked(true);
    };
    const offAuth = bridge.auth.onChange((session) => {
      if (session?.account.id !== accountId) revoke();
      else if (bridge.auth.activationIdentity !== openingActivation) revoke(true);
    });
    const offEvents = bridge.officialUiEvents((event) => {
      if (event.type === "signed-out") revoke();
      else if (!sharedChat) {
        dictation.observe(event);
        if (event.type === "resync") resolveDesign();
        if (event.type !== "conversation" && event.type !== "conversation-turn") return;
        if (!ownOfficialId || !organization || !current()) return;
        if (pendingDesignRead?.route === location.pathname + location.search)
          pendingDesignRead.events.push(event);
        const panel = designPanel;
        if (!panel) return;
        const next = event.type === "conversation"
          ? event.conversation.id === panel.conversation.id ? event.conversation : undefined
          : mergeConversationTurn(panel.conversation, event);
        if (next) {
          const stillOwned = isOwnedDesign(next, ownOfficialId, organization) &&
            next.blankArtifact.id === panel.conversation.blankArtifact.id;
          showDesign(stillOwned ? { ...panel, conversation: next } : undefined);
        }
      }
    });
    const back = (event: PopStateEvent) => {
      if (!current()) return;
      if (billingEntry && billingAvailable() && location.href === billingEntry.route) {
        if (event.state?.claudexBilling === billingEntry.id) {
          showBilling(billingEntry);
          return;
        }
        if (billingVisible) {
          const { trigger } = billingEntry;
          showBilling(undefined);
          requestAnimationFrame(() => {
            if (current() && !billingVisible) trigger.focus({ preventScroll: true });
          });
          return;
        }
      }
      if (billingVisible) showBilling(undefined);
      const panel = designPanel;
      if (panel && deferFileTransition(restartFrame, "pane", () => {
        if (current()) history.pushState(panel.fromGallery ? { claudexDesignFromGallery: true } : null, "", panel.route);
      })) return;
      restartFrame();
    };
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("pagehide", releaseTerminals);
      window.removeEventListener("pagehide", dictation.dispose);
      window.removeEventListener("pagehide", retireNotifications);
      retireNotifications();
      terminals?.dispose();
      dictation.dispose();
      active = false;
      documentGate.revoke();
      scoped.dispose();
      node.removeEventListener("load", loaded);
      window.removeEventListener("message", frameError);
      authorizedWindow?.removeEventListener("pagehide", retireDocument);
      offAuth();
      offEvents();
      window.removeEventListener("popstate", back);
      if (window.__claudexOfficialFrameBindings === authorize)
        delete window.__claudexOfficialFrameBindings;
    };
  }, [bridge, accountId, version, revoked, error, chatActionMode, memoryControlsOptIn, appearanceSettingsOptIn, userContentOrigin, callbackPending]);
  const visibleDesign = !error && !revoked && !callbackPending && design?.isCurrent() ? design : undefined;
  return (
    <div className="official-web-host">
      {error ? <BootErrorPage error={error} /> : !revoked && !callbackPending && (
        <iframe
          key={`${accountId}:${version}`}
          ref={frame}
          title="Claudex"
          src="/official-frame.html"
          className="official-web-frame"
          inert={billing !== undefined || visibleDesign !== undefined}
          onError={() =>
            setError(new Error("Official frame failed to load"))
          }
        />
      )}
      {visibleDesign && (
        <div className="official-design-panel">
          <Suspense fallback={<p role="status">{t("Loading artifact…")}</p>}>
            <BlankDesignCanvas
              key={visibleDesign.conversation.blankArtifact.id}
              accountId={accountId}
              owner={visibleDesign.owner}
              bridge={bridge.api}
              isCurrent={visibleDesign.isCurrent}
              title={visibleDesign.conversation.title}
              conversation={{ ...visibleDesign.conversation, lastTurn: visibleDesign.conversation.turns.at(-1) }}
              onBack={visibleDesign.back}
            />
          </Suspense>
        </div>
      )}
      {billing && !error && !revoked && !callbackPending && (
        <section
          className="official-billing-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape" && event.target instanceof Node &&
                event.currentTarget.contains(event.target) && !hasEscapeLayer()) billing.back();
          }}
        >
          <header>
            <button
              ref={billingBack}
              className="official-billing-back"
              type="button"
              onClick={billing.back}
            >
              <ArrowLeft size={16} />
              {t("Back")}
            </button>
          </header>
          <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
            <BillingView email={billing.email} />
          </Suspense>
        </section>
      )}
    </div>
  );
}
