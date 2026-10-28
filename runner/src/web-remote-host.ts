/**
 * The desktop's remote mode (electron/remote/host.ts) for a web user. The
 * IPC handlers read the account's plan, policy, usage, billing and catalog
 * through `ctx.remote` exactly as on the desktop; only three things differ:
 *
 * - the session: the runner holds no refresh token. Every relayed call
 *   carries the user's current access token (Go checked it and forwards it,
 *   web plan §1.2); `WebSession` uses the newest one and never refreshes.
 *   A revoked session (CLAUDEX_SESSION_REVOKED) closes the user's context.
 * - the key: instead of registering a desktop device (`POST
 *   /claudex/devices`) the runner asks Go for the user's managed web key
 *   (`key.get`, W-KEY: one platform='web' device per user, not counted
 *   against the device limit). It stays in memory (provider keys are never
 *   written on the runner: the shim's safeStorage has no encryption).
 * - signing out of "this device" is the web session's business (Go).
 *
 * `key.get` (runner → Go, body `{}`) answers
 *   `{deviceId: <uuid of the web device>, registration: <the data object of
 *   POST /api/v1/claudex/devices, snake_case>}`;
 * the device id goes into `X-Claudex-Device-Id` of bootstrap, policy and
 * usage reads, so they describe the web device.
 */
import fs from "node:fs";
import path from "node:path";
import {
  claudexErrorCodes,
  parseDeviceRegistration,
  validDeviceId,
  type ClaudexDeviceRegistration,
  type DeviceRegistrationRequest,
} from "../../shared/claudex-contract";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import type { AppContext } from "../../electron/app/app-context";
import type {
  ProviderCredentials,
  StorageCipher,
} from "../../electron/engine/provider-credentials";
import { RemoteHost } from "../../electron/remote/host";
import { RemoteBackend } from "../../electron/sub2api/backend";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { Sub2ApiError, type Fetch } from "../../electron/sub2api/http";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { remoteAccountId } from "../../electron/sub2api/identity-support";
import { RemoteSession, SessionFile } from "../../electron/sub2api/session";

/** Nothing on the runner is encrypted at rest by the OS: keep keys in memory. */
export const noCipher: StorageCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("Encryption is not available on the runner.");
  },
  decryptString: () => {
    throw new Error("Encryption is not available on the runner.");
  },
};

/** The user's managed web key as Go hands it over. */
export interface WebKey {
  deviceId: string;
  registration: ClaudexDeviceRegistration;
}

/** Reads a `key.get` answer. */
export function parseWebKey(value: unknown): WebKey {
  const answer = value as { deviceId?: unknown; registration?: unknown };
  if (!answer || typeof answer !== "object" || !validDeviceId(answer.deviceId))
    throw new Error("The Claudex service sent an invalid web key.");
  return {
    deviceId: answer.deviceId,
    registration: parseDeviceRegistration(answer.registration),
  };
}

const expired = () =>
  new Sub2ApiError(
    401,
    "TOKEN_EXPIRED",
    "Your session has expired. Sign in again.",
  );

/** Sub2API calls with the key coming from Go instead of a device registration. */
export class WebSub2ApiClient extends Sub2ApiClient {
  /** The first key, read before the backend's first load. */
  first?: ClaudexDeviceRegistration;
  constructor(
    baseUrl: string,
    private readonly key: () => Promise<WebKey>,
    fetchImpl: Fetch = fetch,
  ) {
    super(baseUrl, fetchImpl);
  }
  override async registerDevice(
    _accessToken: string,
    _deviceId: string,
    _request: DeviceRegistrationRequest,
  ): Promise<ClaudexDeviceRegistration> {
    const first = this.first;
    this.first = undefined;
    return first ?? (await this.key()).registration;
  }
  // The web session belongs to Go: the runner never signs in or out.
  override async revokeCurrentDevice(): Promise<never> {
    throw new Error(notAvailableOnWeb);
  }
  override async refresh(): Promise<never> {
    throw expired();
  }
  override async logout(): Promise<never> {
    throw new Error(notAvailableOnWeb);
  }
  override async revokeAllSessions(): Promise<never> {
    throw new Error(notAvailableOnWeb);
  }
  override async login(): Promise<never> {
    throw new Error(notAvailableOnWeb);
  }
}

/** RemoteAccounts whose client is a WebSub2ApiClient. */
export class WebRemoteAccounts extends RemoteAccounts {
  declare readonly client: WebSub2ApiClient;
  constructor(root: string, baseUrl: string, client: WebSub2ApiClient) {
    super(root, baseUrl, noCipher);
    Object.defineProperty(this, "client", {
      value: client,
      writable: false,
      enumerable: true,
    });
  }
  /** Every web service is a Claudex service. */
  override async serviceKind(): Promise<"claudex"> {
    return "claudex";
  }
}

const codesToRetry = new Set([
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "UNAUTHORIZED",
]);

/** A session that uses the access token of the newest relayed call. */
export class WebSession extends RemoteSession {
  private current = "";
  constructor(
    client: Sub2ApiClient,
    root: string,
    input: { baseUrl: string; userId: number; email: string },
  ) {
    super(client, new SessionFile(root, noCipher), {
      version: 1,
      baseUrl: input.baseUrl,
      accountId: remoteAccountId(input.baseUrl, input.userId),
      userId: input.userId,
      email: input.email,
      refreshToken: "web",
    });
  }
  /** The token Go forwarded with the latest call of this user. */
  setAccessToken(token: string) {
    this.current = token;
  }
  get hasToken() {
    return Boolean(this.current);
  }
  override async refresh(): Promise<void> {
    throw expired();
  }
  override async authorized<T>(
    call: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const first = this.current;
    if (!first) throw expired();
    try {
      return await call(first);
    } catch (error) {
      if (!(error instanceof Sub2ApiError) || error.status !== 401) throw error;
      if (error.code === claudexErrorCodes.sessionRevoked) {
        // Only the client that sent this token signed out (one desktop or
        // phone leaving): the token is dropped, and a newer one from another
        // client carries on. Signing the whole user out is the service's
        // call (revoke-all reaches the runner as its own sign-out).
        if (this.current === first) this.current = "";
        else if (this.current) return await call(this.current);
        throw error;
      }
      // A newer call may have brought a fresh token meanwhile.
      if (
        codesToRetry.has(error.code) &&
        this.current &&
        this.current !== first
      )
        return await call(this.current);
      throw error;
    }
  }
  override async logout() {
    this.end();
  }
  override async revokeAll(): Promise<void> {
    throw new Error(notAvailableOnWeb);
  }
  override end() {
    this.current = "";
  }
}

/** Writes the web device's id where RemoteBackend reads this installation's id. */
function rememberDeviceId(dataRoot: string, id: string) {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const file = path.join(dataRoot, "device-id");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8").trim();
  } catch {
    // Written below.
  }
  if (current !== id) fs.writeFileSync(file, id, { mode: 0o600 });
}

export interface WebRemoteParts {
  host: WebRemoteHost;
  session: WebSession;
  client: WebSub2ApiClient;
}

/** The remote host of one web user. */
export class WebRemoteHost extends RemoteHost {
  constructor(
    ctx: AppContext,
    backend: RemoteBackend,
    private readonly web: {
      client: WebSub2ApiClient;
      key: () => Promise<WebKey>;
      dataRoot: string;
    },
  ) {
    super(ctx, backend);
  }
  /**
   * The web key first (it names the web device for the bootstrap), then the
   * desktop's own plan, catalog and model reading.
   */
  override async prepare(credentials: ProviderCredentials) {
    const key = await this.web.key();
    rememberDeviceId(this.web.dataRoot, key.deviceId);
    this.web.client.first = key.registration;
    await super.prepare(credentials);
  }
  /** The web session leaves through Go, never from the runner. */
  override async leaveDevice() {}

  /** Builds the host, its backend and session for one user. */
  static create(
    ctx: AppContext,
    input: {
      baseUrl: string;
      dataRoot: string;
      userId: number;
      email: string;
      key: () => Promise<WebKey>;
      fetch?: Fetch;
    },
  ): WebRemoteParts {
    const client = new WebSub2ApiClient(input.baseUrl, input.key, input.fetch);
    const accounts = new WebRemoteAccounts(
      input.dataRoot,
      input.baseUrl,
      client,
    );
    const session = new WebSession(client, input.dataRoot, input);
    const backend = new RemoteBackend(accounts, session, input.dataRoot);
    const host = new WebRemoteHost(ctx, backend, {
      client,
      key: input.key,
      dataRoot: input.dataRoot,
    });
    return { host, session, client };
  }
}
