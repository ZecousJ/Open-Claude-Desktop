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
import { isOfficialUiAction, isOfficialUiLargeResponse, isOfficialUiCompletionSubmission, officialUiActionPath, officialUiRequestLimit, officialSkillUploadKind, officialChatUploadOrganization, officialUiSegmentedRequestLimit, type OfficialUiReadRequest, type OfficialUiReadResponse, type OfficialUiWireRequest } from "../../shared/official-ui-web";
import { officialCoworkMemory } from "../../shared/official-cowork-memory";
import { officialCodeUserSettingsMaxBytes, officialCodeUserSettingsOrganization } from "../../shared/official-code-user-settings";
import { officialMcpAppToolboxTarget } from "../../shared/official-ui-web";
import { officialMelangeEditRequest, officialMelangeImportBodyBytes, officialMelangeRoute } from "../../shared/official-melange";
import { officialMemoryAction } from "../../shared/official-memory-capability";
import { knowledgeFileLimit } from "../../shared/collections-api";
import { collectOfficialResponse } from "../../shared/web-client/official-response";
import { isOfficialUiFileReadPath } from "../../shared/official-ui-web";
import {
  webMethodTable,
  type WebMethodKind,
} from "../../shared/web-bridge-methods";
import { absentMethod } from "./absent";
import { WebAuth } from "./auth";
import { createBrowserMethods } from "./browser-methods";
import { encodeCall, inlineBytes, upload, type UploadRef, type UploadTransfer } from "../../shared/web-client/codec";
import type { WebDictation } from "./dictation";
import {
  createAnnouncementMethods,
  createOfficialAnnouncements,
} from "./announcements";
import type { OfficialAnnouncements } from "../../shared/announcements-api";
import { createOnboardingMethods } from "./onboarding";
import {
  createOfficialZecousMigration,
  createZecousMigrationMethods,
} from "./zecous-migration";
import type { OfficialZecousMigration } from "../../shared/zecous-migration-api";
import { createActiveSessionMethods } from "./active-sessions";
import { createAccountProfileMethods } from "./account-profile";
import { createPasskeyMethods } from "./account-passkeys";
import { createUsageStatsMethods } from "./usage-stats";
import { createServiceStatusMethods } from "./service-status";
import { createKnowledgeMethods } from "./knowledge";
import { createApiKeyMethods } from "./api-keys";
import { createWebProductFeedback } from "./product-feedback";
import { createGitHubMethods } from "../../shared/web-client/github";
import { apiError, apiValue, readJson } from "../../shared/web-client/errors";
import {
  officialPluginOrganizationTarget,
  pluginOrganizationNotFoundCode,
  pluginOrganizationRefusal,
  pluginOrganizationResponse,
  pluginOrganizationServicePath,
  validPluginOrganizationQuery,
} from "../../shared/official-plugin-organizations";
import { parseSharedChat } from "../../shared/sharing";
import type { SharedChatContent } from "../../shared/sharing-api";
import type { WebEnv } from "../../shared/web-client/env";
import { EventStream } from "../../shared/web-client/events";
import { EventHub } from "../../shared/web-client/hub";
import { BridgeState, webSnapshot } from "./state";
import { WebTransport } from "../../shared/web-client/transport";
import { rpcRequest } from "../../shared/web-protocol";
import { CoworkDevices } from "./cowork-devices";
import { BrowserDeviceTrustClient } from "./device-trust-client";
import { createWebDispatch } from "./dispatch";
import type { OfficialDispatch } from "../../shared/dispatch-api";
import type { DeviceAppEvent } from "../../shared/remote-devices";
import { createOfficialRemoteCodeController } from "../../shared/official-remote-code-controller";

type Method = (...args: any[]) => Promise<unknown>;

export interface WebBridge {
  api: DesktopAPI;
  auth: WebAuth;
  stream: EventStream;
  activeSessions: ReturnType<typeof createActiveSessionMethods>;
  dispatch: OfficialDispatch;
  officialRemoteCode: ReturnType<typeof createOfficialRemoteCodeController>;
  officialAnnouncements: OfficialAnnouncements;
  officialZecousMigration: OfficialZecousMigration;
  submitProductFeedback: ReturnType<typeof createWebProductFeedback>;
  state: BridgeState;
  /** Which implementation each call got (tests, diagnostics). */
  kinds: ReadonlyMap<string, WebMethodKind>;
  /** Experimental official frontend bridge; the runner still enforces its whitelist. */
  officialUiRead(request: OfficialUiReadRequest): Promise<OfficialUiReadResponse>;
  officialUiAction(request: OfficialUiReadRequest, transfer?: UploadTransfer): Promise<OfficialUiReadResponse>;
  readSharedChat(token: string): Promise<SharedChatContent>;
  releaseOfficialCodeTerminal(request: OfficialUiReadRequest): void;
  /** Stops a timeline as soon as this tab leaves the account that opened it. */
  officialUiEvents(listener: (event: AppEvent) => void): () => void;
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

type DispatchNotice = Extract<DeviceAppEvent, { type: "dispatch-notification" }>;
type ShowDispatchNotice = (
  deviceId: string,
  event: DispatchNotice,
  current: () => boolean,
) => void;

export function createWebBridge(
  env: WebEnv,
  { dispatchNotice }: { dispatchNotice?: ShowDispatchNotice } = {},
): WebBridge {
  const tabId = env.randomId();
  const hub = new EventHub();
  const state = new BridgeState(() => env.now());
  const auth = new WebAuth(env, tabId, (event) => hub.emit(event));
  const transport = new WebTransport(env, auth, tabId);
  const stopSnapshotInvalidation = hub.subscribe(() => transport.invalidateSnapshotRead());
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
  const officialRemoteCode = createOfficialRemoteCodeController({
    list: () => devices.list(),
    call: (device, request) => devices.rpc(device, "officialCode", [request]),
    changed: (conversationId) => hub.emit({ type: "remote-code-changed", conversationId }),
  });
  let disposed = false;
  const notifyDispatch = (deviceId: string, event: DispatchNotice) => {
    const activation = auth.activationIdentity;
    if (!activation || disposed) return;
    const current = () => !disposed && auth.activationIdentity === activation;
    if (dispatchNotice) {
      dispatchNotice(deviceId, event, current);
      return;
    }
    void import("../../src/dispatch/notifications")
      .then(({ showDispatchNotification }) => {
        if (current()) showDispatchNotification(deviceId, event, { current });
      })
      .catch(() => {});
  };
  const dispatch = createWebDispatch(env, {
    devices,
    account: () => auth.current?.account.id,
    captureActivation: () => transport.captureActivation(),
    notify: dispatchNotice && notifyDispatch,
  });
  env.onOnline(dispatch.wake);
  const deviceTimer = env.timers.setInterval(() => {
    void devices.refresh();
  }, 60_000);
  const send = async (method: string, args: unknown[], current = transport.captureActivation(), meta?: { eventSeq?: number }, signal?: AbortSignal) =>
    transport.call(method, await encodeCall(args, transport, current), meta, current, signal);
  // Reads that several parts of the window ask for at once (the menus, the
  // usage meter, each composer): one request while the same one is in
  // flight. Each is a round trip through Go to the runner.
  const inFlight = new Map<string, Promise<unknown>>();
  const call = (method: string, args: unknown[]) => {
    const current = transport.captureActivation();
    const scopedSend = () => send(method, args, current);
    const route = async (fallback = scopedSend) => {
      current();
      const answer = await devices.route(method, args, fallback);
      current();
      return answer;
    };
    // A computer's Remote Control session reads its turns from that computer.
    if (method === "conversationTurns" || method === "listSessionLoops") {
      if (devices.owns(args[0]))
        return route();
      // A computer's session opened by its address (a reload, a link)
      // before the computers' lists arrived: the service doesn't have it,
      // so once they arrive it is read from its computer instead.
      return scopedSend().catch(async (error) => {
        current();
        if (!/conversation not found/i.test(String(error?.message ?? error)))
          throw error;
        await devices.refresh();
        current();
        if (!devices.owns(args[0])) throw error;
        return route(() => Promise.reject(error));
      });
    }
    if (!sharedReads.has(method))
      return route();
    const key = `${method}\u0000${JSON.stringify(args)}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const request = scopedSend().finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
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
      intercept: (event) => {
        if (event.type === "devices-changed") dispatch.wake();
        if (event.type === "device-event" && event.event.type === "device-conversations")
          hub.emit({ type: "remote-code-changed" });
        return devices.event(event);
      },
      dispatchNotification: (event) => {
        if (event.event.type === "dispatch-notification")
          notifyDispatch(event.deviceId, event.event);
      },
    },
    tabId,
  );
  // Dictation's code loads with the first dictation (kept off the first load).
  let loaded: Promise<WebDictation> | undefined;
  const real = () =>
    (loaded ??= import("./dictation").then(
      ({ WebDictation }) => new WebDictation(env, auth, () => call("voiceAvailability", [])),
    ));
  const dictation = {
    start: async (options?: unknown) => {
      const current = transport.captureActivation();
      current();
      const instance = await real();
      current();
      return instance.start(options);
    },
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
    ...createZecousMigrationMethods(transport),
    ...createAccountProfileMethods(transport, env.origin),
    ...createPasskeyMethods(transport, env),
    ...createUsageStatsMethods(transport),
    ...createServiceStatusMethods(transport),
    ...createKnowledgeMethods(transport),
    // Adding an account marks this tab only (src-web/bridge/auth.ts).
    addAccount: (email?: string) => auth.addAccount(email),
    cancelAddAccount: () => auth.cancelAddAccount(),
    // The page's Google button has no wait to stop.
    cancelGoogleSignIn: async () => undefined,
  };

  // A snapshot with the last event number it holds (Go's answer header): a
  // stream that comes up at that number missed nothing.
  type Fetched = { value: unknown; eventSeq?: number };
  const fetchSnapshot = async (current = transport.captureActivation()): Promise<Fetched> => {
    const meta: { eventSeq?: number } = {};
    const value = await send("snapshot", [], current, meta);
    return { value, eventSeq: meta.eventSeq };
  };
  // The first snapshot is asked for as soon as the session is known, while
  // the window still loads its policy and renders; the window's own first
  // call takes this answer.
  let early: Promise<Fetched> | undefined;

  // Signed in: open the stream. Signed out: close it and forget the account.
  let active: object | undefined;
  auth.onChange((session) => {
    const activation = auth.activationIdentity;
    if (activation === active) return;
    active = activation;
    stream.stop();
    devices.clear();
    officialRemoteCode.clear();
    dispatch.reset();
    state.clear();
    transport.invalidateSnapshotRead();
    inFlight.clear();
    early = undefined;
    if (session) {
      stream.start();
      early = fetchSnapshot();
      early.catch(() => {});
    }
  });

  const remote: Record<string, Method> = {
    snapshot: async () => {
      const current = transport.captureActivation();
      current();
      const pushed = state.takePushed();
      const first = early;
      early = undefined;
      const fetched = async () => {
        if (first) {
          try {
            return await first;
          } catch {
            current();
          }
        }
        return fetchSnapshot(current);
      };
      if (pushed) {
        const snapshot = await devices.snapshot(pushed);
        current();
        state.loaded(snapshot);
        return snapshot;
      }
      const { value, eventSeq } = await fetched();
      current();
      const snapshot = await devices.snapshot(
        webSnapshot(value as Snapshot, env.platformHint),
      );
      current();
      state.loaded(snapshot, eventSeq);
      return snapshot;
    },
    deleteConversation: async (id: string) => {
      const current = transport.captureActivation();
      await call("deleteConversation", [id]);
      current();
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

  const officialCall = async (method: "officialUiRead" | "officialUiAction", request: OfficialUiReadRequest, transfer?: UploadTransfer) => {
    const activation = auth.activationIdentity;
    const isCurrent = () => activation !== undefined && auth.activationIdentity === activation;
    const currentActivation = transport.captureActivation();
    const current = () => {
      transfer?.signal.throwIfAborted();
      currentActivation();
    };
    const readChunk = (path: string) => send("officialUiRead", [{ method: "GET", path }], current);
    const responsePath = request.method === "GET" ? request.path.split("?")[0] : request.path;
    const search = request.path.slice(responsePath.length);
    const organization = method === "officialUiRead" && officialPluginOrganizationTarget(request.method, responsePath, search);
    if (organization && organization.kind !== "catalog") {
      const answer = (status: number, value: unknown): OfficialUiReadResponse => ({
        status,
        contentType: "application/json; charset=utf-8",
        body: new TextEncoder().encode(JSON.stringify(value)),
      });
      if (!validPluginOrganizationQuery(organization, search)) return answer(400, pluginOrganizationRefusal(400));
      try {
        const response = await transport.fetch(
          "/api/v1" + pluginOrganizationServicePath(organization),
          { method: "GET", signal: AbortSignal.timeout(15_000) },
          current,
        );
        const value = await readJson(response);
        current();
        if (response.ok)
          return answer(200, pluginOrganizationResponse(organization, apiValue(response.status, value), search));
        const absent = organization.kind === "marketplaces" && response.status === 404 &&
          apiError(response.status, value).code === pluginOrganizationNotFoundCode;
        const status = absent ? 404 : 503;
        return answer(status, pluginOrganizationRefusal(status));
      } catch {
        current();
        return answer(503, pluginOrganizationRefusal(503));
      }
    }
    const allowTransfer = isOfficialUiLargeResponse(request.method, responsePath) &&
      (method === "officialUiAction") === isOfficialUiAction(request.method, request.path);
    if (method === "officialUiAction" && request.method === "PUT" && officialCodeUserSettingsOrganization(request.path)) {
      if ((request.body?.byteLength ?? 0) > officialCodeUserSettingsMaxBytes)
        throw Error("Code user settings are too large.");
      current();
      const initial = await transport.call(method, JSON.stringify(rpcRequest([request])), undefined, current, transfer?.signal);
      return collectOfficialResponse({ initial, allowTransfer: false, isCurrent, readChunk });
    }
    if (method === "officialUiAction" && officialMelangeRoute(request.method, request.path)?.operation === "external-import") {
      if ((request.body?.byteLength ?? 0) > officialMelangeImportBodyBytes)
        throw Error("The memory import is too large.");
      current();
      const initial = await transport.call(method, JSON.stringify(rpcRequest([request])), undefined, current);
      return collectOfficialResponse({ initial, allowTransfer: false, isCurrent, readChunk });
    }
    const { body, ...metadata } = request;
    const coworkMemory = officialCoworkMemory(request.method, request.path);
    const limit = officialUiSegmentedRequestLimit(request.method, request.path);
    const chatUpload = officialChatUploadOrganization(request.method, request.path);
    const fileUpload = officialSkillUploadKind(request.method, request.path) || chatUpload;
    if (method === "officialUiAction" && fileUpload && body && limit !== undefined && body.byteLength <= limit) {
      current();
      let payload: typeof metadata & { body: Uint8Array | UploadRef } | typeof metadata & { bodySegments: UploadRef[] };
      const inline = body.byteLength <= inlineBytes && (!chatUpload || transfer?.private === true);
      if (inline) {
        payload = { ...metadata, body };
      } else {
        const parts: UploadRef[] = [];
        for (let offset = 0; offset < body.byteLength; offset += knowledgeFileLimit) {
          const chunk = body.subarray(offset, offset + knowledgeFileLimit);
          const id = await upload(transport, chunk, { type: request.contentType, private: transfer?.private === true }, current, transfer && {
            signal: transfer.signal,
            onProgress: (loaded) => transfer.onProgress?.(offset + loaded, body.byteLength),
          });
          parts.push({ $upload: id });
        }
        payload = parts.length === 1 ? { ...metadata, body: parts[0] } : { ...metadata, bodySegments: parts };
      }
      const initial = await send(method, [payload], current);
      current();
      if (inline) transfer?.onProgress?.(body.byteLength, body.byteLength);
      return collectOfficialResponse({ initial, allowTransfer: false, isCurrent, readChunk });
    }
    if (method === "officialUiAction" && body && body.byteLength > inlineBytes &&
        body.byteLength <= officialUiRequestLimit(request.method, request.path) &&
        (request.path === officialUiActionPath || isOfficialUiCompletionSubmission(request.method, request.path) || coworkMemory?.operation === "patch")) {
      const id = await upload(transport, body, { type: request.contentType, private: !!coworkMemory || transfer?.private === true }, current, transfer);
      const initial = await send(method, [{ ...metadata, body: { $upload: id } }], current, undefined, coworkMemory ? transfer?.signal : undefined);
      return collectOfficialResponse({ initial, allowTransfer: false, isCurrent, readChunk });
    }
    let wireRequest: OfficialUiReadRequest | (typeof metadata & { bodySegments: Uint8Array[] }) = request;
    // JSON escaping and multipart headers can exceed the relay's 30 MiB per-upload limit.
    if (limit !== undefined && body &&
        (method === "officialUiAction") === isOfficialUiAction(request.method, request.path) &&
        body.byteLength > knowledgeFileLimit && body.byteLength <= limit) {
      const bodySegments: Uint8Array[] = [];
      for (let start = 0; start < body.byteLength; start += knowledgeFileLimit)
        bodySegments.push(body.subarray(start, start + knowledgeFileLimit));
      wireRequest = { ...metadata, bodySegments };
    }
    const objectTransfer = allowTransfer && method === "officialUiRead" &&
      request.method === "GET" && isOfficialUiFileReadPath(responsePath);
    const sendRead = (direct: boolean) => send(method, [
      allowTransfer
        ? { ...wireRequest, responseTransfer: true, ...(direct ? { objectTransfer: true } : {}) } satisfies OfficialUiWireRequest
        : wireRequest,
    ], current, undefined,
      (officialMemoryAction(request.method, request.path) === "synthesize" ||
        officialMelangeEditRequest(request.method, request.path)?.kind === "start" || coworkMemory ||
        officialMcpAppToolboxTarget(request.method, request.path)) ? transfer?.signal : undefined);
    let initial: unknown;
    try {
      initial = await sendRead(objectTransfer);
    } catch (error) {
      if (!objectTransfer) throw error;
      current();
      initial = await sendRead(false);
    }
    return collectOfficialResponse({
      initial,
      allowTransfer,
      isCurrent,
      readChunk,
      ...(objectTransfer ? { readFallback: () => sendRead(false) } : {}),
    });
  };
  const officialUiEvents = (listener: (event: AppEvent) => void) => {
    const activation = auth.activationIdentity;
    let closed = false;
    let offEvents = () => {}, offAuth = () => {};
    const close = () => { if (!closed) { closed = true; offEvents(); offAuth(); } };
    const leave = () => { if (!closed) { close(); listener({ type: "signed-out", reason: "session-expired", message: "The active account changed." }); } };
    if (!activation) { queueMicrotask(leave); return close; }
    offEvents = hub.subscribe((event) => { if (!closed && auth.activationIdentity === activation) listener(event); });
    offAuth = auth.onChange(() => { if (auth.activationIdentity !== activation) leave(); });
    return close;
  };
  return {
    api: api as unknown as DesktopAPI,
    auth,
    stream,
    dispatch,
    officialRemoteCode,
    activeSessions: createActiveSessionMethods(transport),
    officialAnnouncements: createOfficialAnnouncements(transport),
    officialZecousMigration: createOfficialZecousMigration(
      transport,
      (current, signal) => send("refreshModels", [], current, undefined, signal),
    ),
    submitProductFeedback: createWebProductFeedback(env, auth, tabId),
    state,
    kinds,
    officialUiRead: (request) => officialCall("officialUiRead", request),
    officialUiAction: (request, transfer) => officialCall("officialUiAction", request, transfer),
    async readSharedChat(token) {
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw Error("Invalid shared chat token.");
      const value = await transport.json(`/api/v1/claudex/sharing/shared-with-me/${token}`);
      const chat = parseSharedChat(apiValue(200, value));
      if (!chat) throw Error("Invalid shared chat response.");
      return chat;
    },
    releaseOfficialCodeTerminal(request) {
      const token = auth.current?.accessToken;
      if (token) transport.keepaliveRpc("officialUiAction", JSON.stringify(rpcRequest([request])), token);
    },
    officialUiEvents,
    dispose() {
      disposed = true;
      stopSnapshotInvalidation();
      transport.invalidateSnapshotRead();
      void loaded?.then((dictation) => dictation.dispose()).catch(() => {});
      env.timers.clearInterval(deviceTimer);
      devices.clear();
      dispatch.dispose();
      stream.stop();
      auth.dispose();
    },
  };
}
