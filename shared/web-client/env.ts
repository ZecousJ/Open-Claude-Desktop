/**
 * What the web bridge takes from the page. Everything is passed in, so the
 * tests run the bridge in Node with fakes, and nothing here reaches for a
 * global at import time.
 */

/** The parts of `WebSocket` the bridge uses. */
export interface SocketLike {
  readonly readyState: number;
  readonly protocol: string;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

/** `WebSocket.OPEN`. */
export const socketOpen = 1;

/** `BroadcastChannel` without the DOM event types. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** A file the person picked. */
export interface PickedFile {
  name: string;
  size: number;
  type: string;
  bytes(): Promise<Uint8Array>;
}

export interface WebEnv {
  /** The page's origin, e.g. "https://claudex.example". */
  origin: string;
  fetch: typeof fetch;
  openSocket: SocketFactory;
  /** null where BroadcastChannel is missing (each tab refreshes alone). */
  channel(name: string): ChannelLike | null;
  /** Runs `task` under a cross-tab lock (Web Locks), or directly without. */
  withLock<T>(name: string, task: () => Promise<T>): Promise<T>;
  timers: Timers;
  now(): number;
  randomId(): string;
  /** Saves data as a download named `name`. */
  download(name: string, data: Blob): void;
  /** Opens the file picker; resolves [] when the person cancels. */
  pickFiles(options: {
    accept: string;
    multiple: boolean;
  }): Promise<PickedFile[]>;
  /**
   * Opens a new tab. For an address known only later (after a call), the
   * tab opens now, while the click's user activation lasts, and is pointed
   * at the address, or closed, once it is known.
   */
  openTab(url: string | Promise<string>): Promise<void>;
  /** Navigates this tab (payment pages). */
  navigate(url: string): void;
  /** With `html`, the clipboard holds the text and its rich-text form where the browser allows. */
  writeClipboard(text: string, html?: string): Promise<void>;
  writeImageClipboard(src: string): Promise<void>;
  /** "denied" when the person blocked the microphone for this site. */
  microphonePermission(): Promise<"granted" | "denied" | "prompt">;
  /** navigator.userAgentData.platform, or the user agent string. */
  platformHint: string;
  /** Called when the tab shows, hides, gains or loses focus. */
  onVisibility(listener: (visible: boolean, focused: boolean) => void): void;
  /** Called when the browser comes back online. */
  onOnline(listener: () => void): void;
  /** A development build reports calls to absent methods with a stack. */
  development: boolean;
  /** sessionStorage, when the page may use it. */
  sessionValue(key: string): string | undefined;
  /** Stores a sessionStorage value; undefined removes it. */
  setSessionValue?(key: string, value: string | undefined): void;
  /** localStorage (shared by the origin's tabs), when the page may use it. */
  localValue?(key: string): string | undefined;
  /** Stores a localStorage value; undefined removes it. */
  setLocalValue?(key: string, value: string | undefined): void;
  /**
   * Signs a passkey challenge (the `options` of `passkey/login/begin`) and
   * returns the assertion as JSON; absent where the browser has no passkeys.
   */
  passkey?(options: unknown): Promise<Record<string, unknown>>;
  /**
   * Makes a passkey from the creation options of
   * `user/passkeys/register/begin` and returns the attestation as JSON.
   */
  passkeyCreate?(options: unknown): Promise<Record<string, unknown>>;
}
