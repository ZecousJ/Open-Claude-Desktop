/**
 * The web version's `window.desktop` (W-ARCH §3, web plan §1): the same
 * DesktopAPI the Electron preload exposes, so the renderer in src/ runs
 * unchanged. Every call goes where shared/web-bridge-methods.ts puts it:
 *
 * - remote-runner: HTTPS RPC to Go, which relays it to the user's runner
 *   (transport.ts, codec.ts);
 * - remote-go: the web sign-in session (auth.ts);
 * - browser: served in the page (browser-methods.ts, dictation.ts);
 * - absent: refused with "Not available on the web." (absent.ts).
 *
 * `onEvent` listens to the tab's event stream (events.ts), which also
 * signs the window out when the service ends the session.
 */
import type { AppEvent, DesktopAPI, Snapshot } from "../../shared/types";
import {
  webMethodTable,
  type WebMethodKind,
} from "../../shared/web-bridge-methods";
import { absentMethod } from "./absent";
import { WebAuth } from "./auth";
import { createBrowserMethods } from "./browser-methods";
import { encodeCall } from "../../shared/web-client/codec";
import type { WebDictation } from "./dictation";
import { createAnnouncementMethods } from "./announcements";
import { createOnboardingMethods } from "./onboarding";
import { createAccountProfileMethods } from "./account-profile";
import { createPasskeyMethods } from "./account-passkeys";
import { createUsageStatsMethods } from "./usage-stats";
import { createServiceStatusMethods } from "./service-status";
import { createApiKeyMethods } from "./api-keys";
import { createGitHubMethods } from "../../shared/web-client/github";
import type { WebEnv } from "../../shared/web-client/env";
import { EventStream } from "../../shared/web-client/events";
import { EventHub } from "../../shared/web-client/hub";
import { BridgeState, webSnapshot } from "./state";
import { WebTransport } from "../../shared/web-client/transport";
import { CoworkDevices } from "./cowork-devices";
import { BrowserDeviceTrustClient } from "./device-trust-client";

type Method = (...args: any[]) => Promise<unknown>;

export interface WebBridge {
  api: DesktopAPI;
  auth: WebAuth;
  stream: EventStream;
  state: BridgeState;
  /** Which implementation each call got (tests, diagnostics). */
  kinds: ReadonlyMap<string, WebMethodKind>;
  dispose(): void;
}

/** Runner reads whose concurrent duplicates share one request. */
const sharedReads = new Set([
  "modelCatalog",
  "weeklyUsageStatus",
  "voiceAvailability",
  "artifactNotes",
  "listConversationGroups",
  "clientPolicy",
  "conversationTurns",
]);

export function createWebBridge(env: WebEnv): WebBridge {
  const tabId = env.randomId();
  const hub = new EventHub();
  const state = new BridgeState(() => env.now());
  const auth = new WebAuth(env, tabId, (event) => hub.emit(event));
  const transport = new WebTransport(env, auth, tabId);
  const devices = new CoworkDevices(
    transport,
    (event) => {
      state.observe(event);
      hub.emit(event);
    },
    new BrowserDeviceTrustClient(
      () =>
        auth.current ? `${env.origin}:${auth.current.account.id}` : undefined,
      env.platformHint,
    ),
  );
  const deviceTimer = env.timers.setInterval(() => {
    void devices.refresh();
  }, 60_000);
  const send = async (method: string, args: unknown[]) =>
    transport.call(method, await encodeCall(args, transport));
  // Reads that several parts of the window ask for at once (the menus, the
  // usage meter, each composer): one request while the same one is in
  // flight. Each is a round trip through Go to the runner.
  const inFlight = new Map<string, Promise<unknown>>();
  const call = (method: string, args: unknown[]) => {
    // A computer's Remote Control session reads its turns from that computer.
    if (method === "conversationTurns" && devices.owns(args[0]))
      return devices.route(method, args, () => send(method, args));
    if (!sharedReads.has(method))
      return devices.route(method, args, () => send(method, args));
    const key = `${method}\u0000${JSON.stringify(args)}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = send(method, args).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
  const stream = new EventStream(
    env,
    auth,
    hub,
    {
      snapshotLoaded: () => state.snapshotLoaded,
      snapshotSeq: () => state.snapshotSeq,
      pushSnapshot: (snapshot) =>
        state.push(webSnapshot(snapshot, env.platformHint)),
      observe: (event) => state.observe(event),
      intercept: (event) => devices.event(event),
      dispatchNotification: (event) => {
        if (event.event.type !== "dispatch-notification") return;
        const notification = event.event;
        void import("../../src/dispatch/notifications")
          .then(({ showDispatchNotification }) =>
            showDispatchNotification(event.deviceId, notification),
          )
          .catch(() => {});
      },
    },
    tabId,
  );
  // Dictation's code loads with the first dictation (kept off the first load).
  let loaded: Promise<WebDictation> | undefined;
  const real = () =>
    (loaded ??= import("./dictation").then(
      ({ WebDictation }) => new WebDictation(env, auth, call),
    ));
  const dictation = {
    start: (options?: unknown) => real().then((d) => d.start(options)),
    audio: (sessionId: string, pcm: Uint8Array) =>
      real().then((d) => d.audio(sessionId, pcm)),
    finish: (sessionId: string) => real().then((d) => d.finish(sessionId)),
    cancel: (sessionId: string) => real().then((d) => d.cancel(sessionId)),
  } as unknown as WebDictation;
  const browser: Record<string, Method> = {
    listCoworkDevices: () => devices.list(),
    // Settings → Account's device access, through each online computer.
    deviceTrustState: () => devices.trustState(),
    setRequireTrustedDevices: (required: boolean) =>
      devices.setTrustRequired(required),
    revokeDeviceTrust: (id: string) => devices.revokeTrusted(id),
    approveDeviceTrust: async () => {
      throw new Error("Approve new devices on the computer itself.");
    },
    rejectDeviceTrust: async () => {
      throw new Error("Approve new devices on the computer itself.");
    },
    ...createBrowserMethods({ env, transport, state, dictation, call }),
    ...createGitHubMethods(transport),
    ...createApiKeyMethods(transport),
    ...createAnnouncementMethods(transport),
    ...createOnboardingMethods(transport),
    ...createAccountProfileMethods(transport, env.origin),
    ...createPasskeyMethods(transport, env),
    ...createUsageStatsMethods(transport),
    ...createServiceStatusMethods(transport),
    // Adding an account marks this tab only (src-web/bridge/auth.ts).
    addAccount: (email?: string) => auth.addAccount(email),
    cancelAddAccount: () => auth.cancelAddAccount(),
    // The page's Google button has no wait to stop.
    cancelGoogleSignIn: async () => undefined,
  };

  // A snapshot with the last event number it holds (Go's answer header): a
  // stream that comes up at that number missed nothing.
  type Fetched = { value: unknown; eventSeq?: number };
  const fetchSnapshot = async (): Promise<Fetched> => {
    const meta: { eventSeq?: number } = {};
    const value = await transport.call(
      "snapshot",
      await encodeCall([], transport),
      meta,
    );
    return { value, eventSeq: meta.eventSeq };
  };
  // The first snapshot is asked for as soon as the session is known, while
  // the window still loads its policy and renders; the window's own first
  // call takes this answer.
  let early: Promise<Fetched> | undefined;

  // Signed in: open the stream. Signed out: close it and forget the account.
  let signedIn: string | undefined;
  auth.onChange((session) => {
    const account = session?.account.id;
    if (account === signedIn) return;
    signedIn = account;
    stream.stop();
    devices.clear();
    state.clear();
    early = undefined;
    if (account) {
      stream.start();
      early = fetchSnapshot();
      early.catch(() => {});
    }
  });

  const remote: Record<string, Method> = {
    snapshot: async () => {
      const pushed = state.takePushed();
      const first = early;
      early = undefined;
      const fetched = async () => {
        if (first) {
          try {
            return await first;
          } catch {
            // Asked again below.
          }
        }
        return fetchSnapshot();
      };
      if (pushed) {
        const snapshot = await devices.snapshot(pushed);
        state.loaded(snapshot);
        return snapshot;
      }
      const { value, eventSeq } = await fetched();
      const snapshot = await devices.snapshot(
        webSnapshot(value as Snapshot, env.platformHint),
      );
      state.loaded(snapshot, eventSeq);
      return snapshot;
    },
    deleteConversation: async (id: string) => {
      await call("deleteConversation", [id]);
      state.forget(id);
    },
  };

  const go: Record<string, Method> = {
    authStatus: () => auth.status(),
    loginAccount: (email: string, password: string) =>
      auth.login(email, password),
    completeTwoFactor: (code: string) => auth.completeTwoFactor(code),
    cancelTwoFactor: () => auth.cancelTwoFactor(),
    sendVerificationCode: (email: string) => auth.sendCode(email),
    registerAccount: (email, password, name, extras) =>
      auth.register(email, password, name, extras),
    logoutAccount: () => auth.logout(),
    revokeAllSessions: () => auth.revokeAll(),
    requestPasswordReset: (email: string) => auth.requestPasswordReset(email),
    resetPassword: (email: string, token: string, password: string) =>
      auth.resetPassword(email, token, password),
    sendSignInCode: (email, request) => auth.sendSignInCode(email, request),
    loginWithCode: (email, code, request) =>
      auth.loginWithCode(email, code, request),
    loginWithPasskey: () => auth.loginWithPasskey(),
    loginWithGoogle: (code?: string) => auth.loginWithGoogle(code),
    browserAccounts: () => auth.browserAccounts(),
    switchAccount: (id: string) => auth.switchAccount(id),
    forgetBrowserAccount: (id: string) => auth.forgetBrowserAccount(id),
  };

  const api: Record<string, unknown> = {};
  const kinds = new Map<string, WebMethodKind>();
  for (const [name, kind] of webMethodTable) {
    let method: Method | undefined;
    if (kind === "remote-runner")
      method = remote[name] ?? ((...args: unknown[]) => call(name, args));
    else if (kind === "remote-go") method = go[name];
    else if (kind === "browser") method = browser[name];
    // A browser or Go call without an implementation is refused like an
    // absent one (the tests keep this list empty).
    kinds.set(name, method ? kind : "absent");
    api[name] = method ?? absentMethod(name, env.development);
  }
  api.onEvent = (listener: (event: AppEvent) => void) =>
    hub.subscribe(listener);

  return {
    api: api as unknown as DesktopAPI,
    auth,
    stream,
    state,
    kinds,
    dispose() {
      env.timers.clearInterval(deviceTimer);
      devices.clear();
      stream.stop();
      auth.dispose();
    },
  };
}
