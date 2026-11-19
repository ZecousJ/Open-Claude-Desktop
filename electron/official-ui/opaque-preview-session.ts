/** Native host-owned inert-preview protocol primitive. NOT wired to Electron,
 * official modules or real artifacts. The trusted shell owns this MessagePort;
 * displayed HTML belongs in a separate opaque nested frame with no bridge. */
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface PreviewPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
  start?(): void;
}
export interface PreviewLease {
  account: string;
  activation: unknown;
  window: unknown;
}
export interface PreviewFrame {
  currentWindow(): unknown;
  isConnected(): boolean;
  /** Host must post only to this exact captured WindowProxy, never a lookup by name. */
  bootstrap(
    target: unknown,
    message: { type: "claudex-preview-bootstrap"; version: 1 },
    transferredPort: PreviewPort,
  ): void;
}
interface Clock {
  now(): number;
  schedule(fn: () => void, milliseconds: number): unknown;
  cancel(timer: unknown): void;
}
const defaultClock: Clock = {
  now: Date.now,
  schedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};
function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Factory called by trusted native host only. `shellProof` is private endpoint
 * configuration: NEVER put it in a frame URL, window.name, parent-window message,
 * logged event, untrusted HTML or renderer-visible app config. The endpoint must
 * bind its document to this lease/frame before embedding the proof in the outer
 * shell. This helper cannot establish that endpoint provenance on its own. */
export function createOpaquePreviewSession(options: {
  lease: PreviewLease;
  currentLease(): PreviewLease | undefined;
  frame: PreviewFrame;
  ports: { host: PreviewPort; shell: PreviewPort };
  lifetimeMs?: number;
  clock?: Clock;
  onSize?(size: { width: number; height: number }): void;
}) {
  const lease = { ...options.lease },
    frame = options.frame,
    ports = options.ports;
  const clock = options.clock ?? defaultClock,
    lifetime = options.lifetimeMs ?? 30000;
  if (
    !lease.account ||
    lease.activation === undefined ||
    lease.window === undefined ||
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > 300000 ||
    ports.host === ports.shell
  )
    throw Error("Invalid preview session configuration.");
  const shellProof = randomBytes(32).toString("hex");
  const expectedWindow = frame.currentWindow();
  if (!expectedWindow || !frame.isConnected())
    throw Error("Preview frame is unavailable.");
  const deadline = clock.now() + lifetime;
  let state: "created" | "awaiting-proof" | "ready" | "revoked" = "created";
  let timer: unknown,
    sequence = 0,
    messages = 0;
  const revoke = () => {
    if (state === "revoked") return;
    state = "revoked";
    ports.host.onmessage = null;
    for (const port of [ports.host, ports.shell]) {
      try {
        port.close();
      } catch {
        /* Revocation never reopens a port. */
      }
    }
    if (timer !== undefined) clock.cancel(timer);
  };
  const active = () => {
    try {
      const current = options.currentLease();
      if (
        state !== "revoked" &&
        clock.now() < deadline &&
        frame.isConnected() &&
        frame.currentWindow() === expectedWindow &&
        current?.account === lease.account &&
        current.activation === lease.activation &&
        current.window === lease.window
      )
        return true;
    } catch {
      /* Unknown identity is not authorization. */
    }
    revoke();
    return false;
  };
  const post = (message: unknown) => {
    if (!active()) return false;
    try {
      ports.host.postMessage(message);
      return active();
    } catch {
      revoke();
      return false;
    }
  };
  ports.host.onmessage = (event) => {
    if (!active()) return;
    if (++messages > 120) {
      revoke();
      return;
    }
    const value = event.data;
    if (!record(value)) {
      revoke();
      return;
    }
    if (state === "awaiting-proof") {
      if (
        !exact(value, ["type", "nonce"]) ||
        value.type !== "claudex-preview-proof" ||
        typeof value.nonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.nonce) ||
        !timingSafeEqual(Buffer.from(value.nonce), Buffer.from(shellProof))
      ) {
        revoke();
        return;
      }
      state = "ready";
      return;
    }
    if (state !== "ready" || value.type === "claudex-preview-proof") {
      revoke();
      return;
    }
    if (
      exact(value, ["type", "width", "height"]) &&
      value.type === "claudex-preview-size" &&
      typeof value.width === "number" &&
      Number.isFinite(value.width) &&
      value.width >= 0 &&
      value.width <= 100000 &&
      typeof value.height === "number" &&
      Number.isFinite(value.height) &&
      value.height >= 0 &&
      value.height <= 100000
    ) {
      if (active())
        options.onSize?.({ width: value.width, height: value.height });
      return;
    }
    // No fetch/model/files/storage/host commands or renderer-selected dispatch.
    post({ type: "claudex-preview-unsupported" });
  };
  timer = clock.schedule(revoke, lifetime);
  return {
    shellProof,
    get state() {
      active();
      return state;
    },
    bootstrap(): boolean {
      if (!active() || state !== "created") return false;
      state = "awaiting-proof";
      try {
        // The adapter implementation may need targetOrigin="*" for an opaque
        // destination. No proof/content/credential is included in this envelope.
        frame.bootstrap(
          expectedWindow,
          { type: "claudex-preview-bootstrap", version: 1 },
          ports.shell,
        );
        ports.host.start?.();
        return active();
      } catch {
        revoke();
        return false;
      }
    },
    renderInertHtml(html: string): boolean {
      if (!active() || state !== "ready") return false;
      if (
        typeof html !== "string" ||
        Buffer.byteLength(html, "utf8") > 1024 * 1024
      )
        throw Error("Preview content exceeds the supported bound.");
      // This goes to the proven private port, NEVER to WindowProxy postMessage.
      return post({
        type: "claudex-preview-inert-html",
        version: 1,
        sequence: ++sequence,
        html,
      });
    },
    /** Mandatory before each document navigation/load (including same WindowProxy),
     * account/session change, frame removal and window close. Never rearm it. */
    onDocumentChange: revoke,
    revoke,
  };
}
