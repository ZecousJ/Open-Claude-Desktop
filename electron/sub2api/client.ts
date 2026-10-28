import {
  parseNativeSessionList,
  parseRelease,
  parseWebSessionList,
  type ClaudexRelease,
  type ClaudexWebSessionList,
} from "../../shared/claudex-contract";
import { privacyPolicyUrl } from "../../shared/sign-in-api";
import {
  requestJson,
  requestJsonResult,
  type Fetch,
  type JsonResult,
} from "./http";
import {
  updateDeviceQuery,
  type UpdateDevice,
} from "../../shared/update-policy";
import { parseCoarseLocation } from "../../shared/location-metadata";
import { object } from "./client-support";
import { count } from "./client-support";
import { user } from "./client-support";
import * as clientAuth from "./client-auth";
import { installMethods } from "./install-methods";
import { list } from "./client-support";
import { malformed } from "./client-support";
import * as clientDevices from "./client-devices";
import { text, time } from "./client-support";

/** The parts of `GET /api/v1/settings/public` that shape sign-in. */
export interface PublicSettings {
  siteName: string;
  registrationEnabled: boolean;
  emailVerifyEnabled: boolean;
  invitationCodeEnabled: boolean;
  promoCodeEnabled: boolean;
  totpEnabled: boolean;
  /** A captcha Claudex cannot display is switched on for sign-in. */
  captchaEnabled: boolean;
  backendModeEnabled: boolean;
  /** "Forgot password?" works (`password_reset_enabled`). */
  passwordResetEnabled: boolean;
  /** The first sign-in agreement document, as `/legal/<id>`, if any. */
  agreementUrl?: string;
  /** Allowed registration email domains, when the operator restricts them. */
  emailSuffixWhitelist: string[];
  docUrl: string;
  purchaseUrl: string;
  /** User-visible custom menu items with a web address (console: 系统设置 → 自定义菜单). */
  menuItems: { label: string; url: string }[];
}
/** `GET /api/v1/announcements`: notices the service shows this user. */
export interface RemoteAnnouncement {
  id: number;
  title: string;
  content: string;
  notifyMode: string;
  startsAt: number | null;
  endsAt: number | null;
  readAt: number | null;
  createdAt: number;
}
export interface RemoteUser {
  id: number;
  email: string;
  username: string;
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token stays valid. */
  expiresIn: number;
}
export type LoginResponse =
  | { kind: "tokens"; tokens: TokenPair; user?: RemoteUser }
  | { kind: "twoFactor"; tempToken: string; maskedEmail: string };
export interface RemoteGroup {
  id: number;
  name: string;
  platform: string;
  subscriptionType: string;
  status: string;
}
export interface RemoteSubscription {
  id: number;
  groupId: number;
  status: string;
  expiresAt: number | null;
  group?: RemoteGroup;
}
export interface RemoteKey {
  id: number;
  name: string;
  key: string;
  groupId: number | null;
  status: string;
  createdAt?: number | null;
  lastUsedAt?: number | null;
}
/** `GET /api/v1/user/profile`, the parts Settings shows. */
export interface RemoteProfile extends RemoteUser {
  /** US dollars. */
  balance: number;
}
/** `POST /api/v1/redeem`: what the code added. */
export interface RedeemedCode {
  type: string;
  value: number;
  groupName: string;
  validityDays: number;
}
export interface UsageWindow {
  limitUsd: number;
  usedUsd: number;
  percentage: number;
  resetsAt: number;
}
export interface SubscriptionProgress {
  subscriptionId: number;
  groupId: number | null;
  groupName: string;
  expiresAt: number | null;
  daily?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
}

export type Json = Record<string, unknown>;
function group(value: unknown): RemoteGroup | undefined {
  const data = object(value);
  if (!Number.isSafeInteger(data.id)) return undefined;
  return {
    id: data.id as number,
    name: text(data.name, 100),
    platform: text(data.platform, 50),
    subscriptionType: text(data.subscription_type, 50),
    status: text(data.status, 50),
  };
}
function window(value: unknown): UsageWindow | undefined {
  const data = object(value);
  const resetsAt = time(data.resets_at);
  if (!Object.keys(data).length || resetsAt === null) return undefined;
  return {
    limitUsd: count(data.limit_usd),
    usedUsd: count(data.used_usd),
    percentage: Math.max(0, Math.min(100, count(data.percentage))),
    resetsAt,
  };
}
/** Items are `{subscription, progress}` in current Sub2API; older builds return the progress alone. */
export function parseProgress(value: unknown): SubscriptionProgress[] {
  return list(value).flatMap((raw) => {
    const item = object(raw);
    const progress = object(item.progress ?? item);
    const subscription = object(item.subscription);
    const id = progress.id ?? subscription.id;
    if (!Number.isSafeInteger(id)) return [];
    const groupId = subscription.group_id;
    return [
      {
        subscriptionId: id as number,
        groupId: Number.isSafeInteger(groupId) ? (groupId as number) : null,
        groupName:
          text(progress.group_name, 100) ||
          text(object(subscription.group).name, 100),
        expiresAt: time(progress.expires_at ?? subscription.expires_at),
        daily: window(progress.daily),
        weekly: window(progress.weekly),
        monthly: window(progress.monthly),
      },
    ];
  });
}

/** Typed calls to the Sub2API user API (`/api/v1`). Tokens are passed in, never stored here. */
export class Sub2ApiClient {
  directoryRequest(
    token: string,
    route: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    if (
      !route.startsWith("/claudex/directory") &&
      route !== "/claudex/skills/scan"
    )
      throw new Error("Failed to submit. You can try again.");
    return this.call(route, { ...init, token });
  }
  constructor(
    readonly baseUrl: string,
    public fetchImpl: Fetch = fetch,
  ) {}
  api(route: string) {
    return `${this.baseUrl}/api/v1${route}`;
  }
  call(route: string, init?: Parameters<typeof requestJson>[2]) {
    return requestJson(this.fetchImpl, this.api(route), init);
  }
  /** User-owned feedback management uses the same authenticated client transport. */
  privacyFeedback(
    accessToken: string,
    method: "GET" | "DELETE",
    route: string,
  ) {
    if (
      !/^feedback\/history(?:\?limit=(?:1|50)(?:&cursor=[A-Za-z0-9%._~-]+)?|\/[a-f0-9-]{36})$/.test(
        route,
      )
    )
      throw Error("Invalid feedback management route.");
    return this.call(`/claudex/${route}`, { token: accessToken, method });
  }
  async publicSettings(): Promise<PublicSettings> {
    const data = object(await this.call("/settings/public"));
    return {
      siteName: text(data.site_name, 100),
      registrationEnabled: data.registration_enabled === true,
      emailVerifyEnabled: data.email_verify_enabled === true,
      invitationCodeEnabled: data.invitation_code_enabled === true,
      promoCodeEnabled: data.promo_code_enabled === true,
      totpEnabled: data.totp_enabled === true,
      captchaEnabled:
        data.turnstile_enabled === true ||
        data.tencent_captcha_enabled === true ||
        data.aliyun_captcha_enabled === true,
      backendModeEnabled: data.backend_mode_enabled === true,
      passwordResetEnabled: data.password_reset_enabled === true,
      agreementUrl: privacyPolicyUrl({ emailCodeLogin: false }, data),
      emailSuffixWhitelist: list(data.registration_email_suffix_whitelist)
        .filter((item): item is string => typeof item === "string")
        .slice(0, 50),
      docUrl: text(data.doc_url, 2000),
      purchaseUrl:
        data.purchase_subscription_enabled === true
          ? text(data.purchase_subscription_url, 2000)
          : "",
      menuItems: list(data.custom_menu_items)
        .flatMap((raw) => {
          const item = object(raw);
          const url = text(item.url, 2000).trim();
          // Admin-only items and Sub2API markdown pages (md:slug) are not links.
          if (item.visibility === "admin" || !/^https?:\/\//.test(url))
            return [];
          return [
            {
              label: text(item.label, 50).trim(),
              url,
              order: count(item.sort_order),
            },
          ];
        })
        .filter((item) => item.label)
        .sort((a, b) => a.order - b.order)
        .slice(0, 20)
        .map(({ label, url }) => ({ label, url })),
    };
  }
  async announcements(accessToken: string): Promise<RemoteAnnouncement[]> {
    return list(await this.call("/announcements", { token: accessToken }))
      .flatMap((raw) => {
        const data = object(raw);
        if (!Number.isSafeInteger(data.id) || typeof data.title !== "string")
          return [];
        return [
          {
            id: data.id as number,
            title: text(data.title, 200),
            content: text(data.content, 20000),
            notifyMode: text(data.notify_mode, 20),
            startsAt: time(data.starts_at),
            endsAt: time(data.ends_at),
            readAt: time(data.read_at),
            createdAt: time(data.created_at) ?? 0,
          },
        ];
      })
      .slice(0, 50);
  }
  async markAnnouncementRead(accessToken: string, id: number) {
    await this.call(`/announcements/${id}/read`, {
      method: "POST",
      token: accessToken,
      body: {},
    });
  }
  async me(accessToken: string): Promise<RemoteUser> {
    return (
      user(await this.call("/auth/me", { token: accessToken })) ?? malformed()
    );
  }
  async profile(accessToken: string): Promise<RemoteProfile> {
    const data = await this.call("/user/profile", { token: accessToken });
    return profile(data) ?? malformed();
  }
  async codeSharingSettings(
    accessToken: string,
    patch?: { requireRepositoryAccess?: boolean; showName?: boolean },
  ) {
    const data = (await this.call("/claudex/sharing/code-settings", {
      token: accessToken,
      ...(patch ? { method: "PATCH", body: patch } : {}),
    })) as { requireRepositoryAccess?: unknown; showName?: unknown };
    if (
      typeof data?.requireRepositoryAccess !== "boolean" ||
      typeof data?.showName !== "boolean"
    )
      malformed();
    return {
      requireRepositoryAccess: data.requireRepositoryAccess as boolean,
      showName: data.showName as boolean,
    };
  }
  async updateUsername(
    accessToken: string,
    username: string,
  ): Promise<RemoteProfile> {
    const data = await this.call("/user", {
      method: "PUT",
      token: accessToken,
      body: { username },
    });
    return profile(data) ?? malformed();
  }
  async redeem(accessToken: string, code: string): Promise<RedeemedCode> {
    const data = object(
      await this.call("/redeem", {
        method: "POST",
        token: accessToken,
        body: { code },
      }),
    );
    return {
      type: text(data.type, 50),
      value: count(data.value),
      groupName: text(object(data.group).name, 100),
      validityDays: count(data.validity_days),
    };
  }
  /** Every subscription, including expired ones. */
  async subscriptions(accessToken: string): Promise<RemoteSubscription[]> {
    return parseSubscriptions(
      await this.call("/subscriptions", { token: accessToken }),
    );
  }
  async availableGroups(accessToken: string): Promise<RemoteGroup[]> {
    return list(await this.call("/groups/available", { token: accessToken }))
      .map(group)
      .filter((item): item is RemoteGroup => !!item);
  }
  async activeSubscriptions(
    accessToken: string,
  ): Promise<RemoteSubscription[]> {
    return parseSubscriptions(
      await this.call("/subscriptions/active", { token: accessToken }),
    );
  }
  async subscriptionProgress(accessToken: string) {
    return parseProgress(
      await this.call("/subscriptions/progress", { token: accessToken }),
    );
  }
  // ---- Claudex routes (design 2.2–2.10). The device id travels only in
  // the X-Claudex-Device-Id header, never in a URL or a body.

  /** `GET /claudex/release` (public). A 404 means the service has no Claudex module. */
  /** `GET /claudex/release`; a Linux build names its package format (deb, rpm, tar). */
  async claudexRelease(
    linuxPackage?: string,
    device?: UpdateDevice,
  ): Promise<ClaudexRelease> {
    const query = device ? updateDeviceQuery(device) : new URLSearchParams();
    if (linuxPackage) query.set("package", linuxPackage);
    return parseRelease(
      await this.call(`/claudex/release${query.size ? `?${query}` : ""}`),
    );
  }
  /** `GET /claudex/bootstrap`, or 304 when `etag` is current. */
  bootstrap(
    accessToken: string,
    deviceId: string,
    etag?: string,
  ): Promise<JsonResult> {
    return requestJsonResult(this.fetchImpl, this.api("/claudex/bootstrap"), {
      token: accessToken,
      deviceId,
      ifNoneMatch: etag,
    });
  }
  /** `GET /claudex/policy`, or 304 when `etag` is current. */
  policy(
    accessToken: string,
    deviceId: string,
    etag?: string,
  ): Promise<JsonResult> {
    return requestJsonResult(this.fetchImpl, this.api("/claudex/policy"), {
      token: accessToken,
      deviceId,
      ifNoneMatch: etag,
    });
  }
  async location(accessToken: string) {
    return parseCoarseLocation(
      await this.call("/claudex/location", { token: accessToken }),
    );
  }
  /** `GET /claudex/web/sessions`: the account's active web app sessions. */
  async webSessions(accessToken: string): Promise<ClaudexWebSessionList> {
    return parseWebSessionList(
      await this.call("/claudex/web/sessions", { token: accessToken }),
    );
  }
  /** `GET /claudex/native-sessions`: the account's phone app sign-ins. */
  async nativeSessions(accessToken: string): Promise<ClaudexWebSessionList> {
    return parseNativeSessionList(
      await this.call("/claudex/native-sessions", { token: accessToken }),
    );
  }
  async deleteKey(accessToken: string, id: number) {
    await this.call(`/keys/${id}`, { method: "DELETE", token: accessToken });
  }
}

export interface Sub2ApiClient {
  registerDevice(
    ...args: Parameters<typeof clientDevices.registerDevice>
  ): ReturnType<typeof clientDevices.registerDevice>;
  revokeCurrentDevice(
    ...args: Parameters<typeof clientDevices.revokeCurrentDevice>
  ): ReturnType<typeof clientDevices.revokeCurrentDevice>;
  devices(
    ...args: Parameters<typeof clientDevices.devices>
  ): ReturnType<typeof clientDevices.devices>;
  revokeDevice(
    ...args: Parameters<typeof clientDevices.revokeDevice>
  ): ReturnType<typeof clientDevices.revokeDevice>;
  revokeWebSession(
    ...args: Parameters<typeof clientDevices.revokeWebSession>
  ): ReturnType<typeof clientDevices.revokeWebSession>;
  revokeNativeSession(
    ...args: Parameters<typeof clientDevices.revokeNativeSession>
  ): ReturnType<typeof clientDevices.revokeNativeSession>;
  listKeys(
    ...args: Parameters<typeof clientDevices.listKeys>
  ): ReturnType<typeof clientDevices.listKeys>;
  createKey(
    ...args: Parameters<typeof clientDevices.createKey>
  ): ReturnType<typeof clientDevices.createKey>;
  moveKey(
    ...args: Parameters<typeof clientDevices.moveKey>
  ): ReturnType<typeof clientDevices.moveKey>;
}
installMethods(Sub2ApiClient.prototype, clientDevices);

export interface Sub2ApiClient {
  login(
    ...args: Parameters<typeof clientAuth.login>
  ): ReturnType<typeof clientAuth.login>;
  signInOptions(
    ...args: Parameters<typeof clientAuth.signInOptions>
  ): ReturnType<typeof clientAuth.signInOptions>;
  forgotPassword(
    ...args: Parameters<typeof clientAuth.forgotPassword>
  ): ReturnType<typeof clientAuth.forgotPassword>;
  resetPassword(
    ...args: Parameters<typeof clientAuth.resetPassword>
  ): ReturnType<typeof clientAuth.resetPassword>;
  sendSignInCode(
    ...args: Parameters<typeof clientAuth.sendSignInCode>
  ): ReturnType<typeof clientAuth.sendSignInCode>;
  loginWithCode(
    ...args: Parameters<typeof clientAuth.loginWithCode>
  ): ReturnType<typeof clientAuth.loginWithCode>;
  loginWithGoogle(
    ...args: Parameters<typeof clientAuth.loginWithGoogle>
  ): ReturnType<typeof clientAuth.loginWithGoogle>;
  loginTwoFactor(
    ...args: Parameters<typeof clientAuth.loginTwoFactor>
  ): ReturnType<typeof clientAuth.loginTwoFactor>;
  register(
    ...args: Parameters<typeof clientAuth.register>
  ): ReturnType<typeof clientAuth.register>;
  sendVerifyCode(
    ...args: Parameters<typeof clientAuth.sendVerifyCode>
  ): ReturnType<typeof clientAuth.sendVerifyCode>;
  refresh(
    ...args: Parameters<typeof clientAuth.refresh>
  ): ReturnType<typeof clientAuth.refresh>;
  logout(
    ...args: Parameters<typeof clientAuth.logout>
  ): ReturnType<typeof clientAuth.logout>;
  revokeAllSessions(
    ...args: Parameters<typeof clientAuth.revokeAllSessions>
  ): ReturnType<typeof clientAuth.revokeAllSessions>;
  deleteAccount(
    ...args: Parameters<typeof clientAuth.deleteAccount>
  ): ReturnType<typeof clientAuth.deleteAccount>;
}
installMethods(Sub2ApiClient.prototype, clientAuth);
function parseSubscriptions(value: unknown): RemoteSubscription[] {
  return list(value).flatMap((raw) => {
    const data = object(raw);
    if (!Number.isSafeInteger(data.id) || !Number.isSafeInteger(data.group_id))
      return [];
    return [
      {
        id: data.id as number,
        groupId: data.group_id as number,
        status: text(data.status, 50),
        expiresAt: time(data.expires_at),
        group: group(data.group),
      },
    ];
  });
}
function profile(value: unknown): RemoteProfile | undefined {
  const base = user(value);
  return base && { ...base, balance: count(object(value).balance) };
}
