import { officialDesignWorkspacePath } from "../../shared/official-design-artifacts";
import {officialUiRequestLimit} from "../../shared/official-ui-web";
import type { AppEvent } from "../../shared/types";
import type { GitHubAPI } from "../../shared/github-api";
import type { OfficialCloudEnvironments } from "./cloud-environment-fetch";
import type { OfficialFrameAccount } from "./account-fetch";
import type { ApiManagement } from "../../shared/official-api-management";
import type { ProductFeedbackAnswer } from "../../shared/product-feedback";
import type { SettingsAccountAPI } from "../../shared/settings-api";
import type { ServiceStatusAPI } from "../../shared/service-status-api";
import type { OfficialCodeTerminalHost } from "./code-terminal";
import type { createOfficialWebDictation } from "./dictation";
import type { UploadTransfer } from "../../shared/web-client/codec";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
type Call = (request: OfficialUiReadRequest, transfer?: UploadTransfer) => Promise<OfficialUiReadResponse>;
export interface OfficialFrameBindings {
  startupIdentity?: import("./startup-identity").StartupIdentity;
  sessionMarker?: string;
  dictation?: ReturnType<typeof createOfficialWebDictation>["host"];
  notificationPreferences?: import("./notification-preferences").OfficialNotificationPreferences;
  requestNotificationPermission?: typeof import("../../src/app/web-notifications").askNotificationPermission;
  userContentOrigin?: string;
  sharedChatSnapshotId?: string;
  account: OfficialFrameAccount;
  apiManagement?: ApiManagement;
  serviceStatus?: ServiceStatusAPI["serviceStatus"];
  announcements?: import("../../shared/announcements-api").OfficialAnnouncements;
  dispatch?: import("../../shared/dispatch-api").OfficialDispatch;
  zecousMigration?: import("../../shared/zecous-migration-api").OfficialZecousMigration;
  submitProductFeedback?: (text: string) => Promise<ProductFeedbackAnswer>;
  exportAccountData?: SettingsAccountAPI["exportData"];
  openBilling?: (trigger: HTMLElement) => boolean;
  githubStatus?: GitHubAPI["githubStatus"];
  githubConnect?: GitHubAPI["githubConnect"];
  githubDisconnect?: GitHubAPI["githubDisconnect"];
  githubBranches?: GitHubAPI["githubBranches"];
  githubRepositories?: GitHubAPI["githubRepositories"];
  cloudEnvironments?: OfficialCloudEnvironments;
  codeTerminal?: OfficialCodeTerminalHost;
  codeStreamConnected?: (key: string) => boolean;
  read: Call;
  action: Call;
  events: (listener: (event: AppEvent) => void) => () => void;
  isCurrent: () => boolean;
  route: string;
  onNavigate: (route: string, replace: boolean) => void;
  onDocumentExit: () => void;
}
/** A real iframe's Uint8Array belongs to another realm. Validate internal slots, not spoofable names. */
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const setBytes = Uint8Array.prototype.set;

export function officialFrameByteLength(body: unknown): number {
  if (!ArrayBuffer.isView(body) || typedArrayTag.call(body) !== "Uint8Array")
    throw new TypeError("An official frame body must be a Uint8Array.");
  // The ArrayBuffer intrinsic rejects SharedArrayBuffer.
  arrayBufferLength.call(typedArrayBuffer.call(body));
  return typedArrayLength.call(body);
}

export function normalizeOfficialFrameRequest(request: OfficialUiReadRequest): OfficialUiReadRequest {
  const body = request.body;
  if(body === undefined)return request;
  const size=officialFrameByteLength(body);
  if(!Number.isSafeInteger(size)||size<0||size>officialUiRequestLimit(request.method,request.path))
    throw new RangeError("The official request body is too large.");
  const copy=new Uint8Array(size);
  setBytes.call(copy,body);
  return {...request,body:copy};
}
/** Scope callbacks to one mounted, authenticated frame. This is not origin isolation. */
export function bindOfficialFrame(
  source: Pick<OfficialFrameBindings, "read" | "action" | "events">,
  isAccountCurrent: () => boolean,
  route: string | (() => string),
  onNavigate: OfficialFrameBindings["onNavigate"],
  onDocumentExit?: () => void,
) {
  let live = true;
  const subscriptions = new Set<() => void>();
  const current = () => live && isAccountCurrent();
  const assert = () => {
    if (!current())
      throw new DOMException("The active account changed.", "AbortError");
  };
  const call =
    (operation: Call): Call =>
    async (request, transfer) => {
      assert();
      const normalized = normalizeOfficialFrameRequest(request);
      assert();
      const answer = await operation(normalized, transfer);
      assert();
      return answer;
    };
  const dispose = () => {
    if (!live) return;
    live = false;
    for (const off of subscriptions) {
      try {
        off();
      } catch {
        /* revoke every subscription even if one cleanup fails */
      }
    }
    subscriptions.clear();
  };
  const events = (listener: (event: AppEvent) => void) => {
    assert();
    let active = true,
      off = () => {};
    const close = () => {
      if (!active) return;
      active = false;
      try {
        off();
      } finally {
        subscriptions.delete(close);
      }
    };
    let registering = true, callbackFailed = false, callbackError: unknown;
    // Register before invoking the source: it may synchronously emit any event,
    // and a consumer can dispose this lease from inside that callback.
    subscriptions.add(close);
    try {
      off = source.events((event) => {
        if (!active) return;
        try {
          if (event.type === "signed-out" || !current()) {
            dispose();
            try { close(); } catch { /* retired even if cleanup throws */ }
            listener({ type: "signed-out", reason: "session-expired", message: "The active account changed." });
            return;
          }
          listener(event);
        } catch (error) {
          dispose();
          try { close(); } catch { /* preserve the consumer error */ }
          if (!registering) throw error;
          callbackFailed = true;
          callbackError = error;
        }
      });
      registering = false;
      if (!active) off();
      if (callbackFailed) throw callbackError;
    } catch (error) {
      registering = false;
      dispose();
      try { close(); } catch { /* preserve the registration error */ }
      throw error;
    }
    return close;
  };
  return {
    bindings: {
      read: call(source.read),
      action: call(source.action),
      events,
      isCurrent: current,
      get route() {
        assert();
        return typeof route === "function" ? route() : route;
      },
      onDocumentExit: () => {
        if (!live) return;
        dispose();
        onDocumentExit?.();
      },
      onNavigate: (value: string, replace: boolean) => {
        assert();
        onNavigate(value, replace);
      },
    } satisfies Omit<OfficialFrameBindings, "account">,
    dispose,
  };
}
export function officialRoute(value: string, origin: string) {
  const url = new URL(value, origin);
  if (
    url.origin !== origin ||
    !url.pathname.startsWith("/") ||
    url.pathname.startsWith("//")
  )
    throw Error("Invalid official frame route.");
  if (/^\/(?:api|edge-api|claudeai-rpc|v1|assets)(?:\/|$)/.test(url.pathname))
    throw Error("Not an application route.");
  if (
    [
      "/official-web.html",
      "/official-frame.html",
      "/index.html",
      "/login",
    ].includes(url.pathname)
  )
    return "/new";
  return officialDesignWorkspacePath(url.pathname) ?? url.pathname + url.search + url.hash;
}
