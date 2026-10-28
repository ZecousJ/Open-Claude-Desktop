/**
 * The browser's WebEnv: sockets, timers, file picking, the image clipboard
 * and passkeys as a web page has them. The types live in shared/web-client/env.
 */
import {
  type ChannelLike,
  type PickedFile,
  type SocketLike,
  type WebEnv,
} from "../../shared/web-client/env";

type Global = typeof globalThis & {
  navigator?: Navigator & {
    userAgentData?: { platform?: string };
  };
};

function pickFiles({
  accept,
  multiple,
}: {
  accept: string;
  multiple: boolean;
}): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    let settled = false;
    const finish = (files: PickedFile[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      window.removeEventListener("focus", focused);
      resolve(files);
    };
    // Browsers without the input's cancel event: the window regains focus
    // when the picker closes, and `change` follows soon if files were chosen.
    const focused = () =>
      setTimeout(() => {
        if (!input.files?.length) finish([]);
      }, 1000);
    input.addEventListener("change", () =>
      finish(
        [...(input.files ?? [])].map((file) => ({
          name: file.name,
          size: file.size,
          type: file.type,
          bytes: async () => new Uint8Array(await file.arrayBuffer()),
        })),
      ),
    );
    input.addEventListener("cancel", () => finish([]));
    window.addEventListener("focus", focused);
    document.body.append(input);
    input.click();
  });
}

export function writeImageClipboard(src: string) {
  return navigator.clipboard.write([
    new ClipboardItem({
      "image/png": import("../../src/ui/image-operations").then(
        ({ imageBlob, pngBlob }) => imageBlob(src).then(pngBlob),
      ),
    }),
  ]);
}

async function writeClipboard(text: string, html?: string) {
  try {
    if (html && typeof ClipboardItem === "function") {
      // Both forms in one item (the original's copy); a browser that refuses
      // the rich form still takes the plain text below.
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return;
      } catch {
        // fall through to plain text
      }
    }
    await navigator.clipboard.writeText(text);
  } catch {
    // An older browser, or a page without clipboard permission.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("Couldn't copy to the clipboard.");
  }
}

/** The real page. */
export function browserEnv(): WebEnv {
  const g = globalThis as Global;
  const nav = g.navigator;
  return {
    origin: location.origin,
    fetch: (input, init) => g.fetch(input, init),
    openSocket: (url, protocols) =>
      new WebSocket(url, protocols) as unknown as SocketLike,
    channel: (name) =>
      typeof BroadcastChannel === "function"
        ? (new BroadcastChannel(name) as unknown as ChannelLike)
        : null,
    withLock: <T>(name: string, task: () => Promise<T>): Promise<T> =>
      nav?.locks?.request
        ? (nav.locks.request(name, () => task()) as Promise<T>)
        : task(),
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    },
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
    download: (name, data) => {
      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.rel = "noopener";
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
      // The browser reads the blob after click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    pickFiles,
    writeImageClipboard,
    openTab: async (url) => {
      if (typeof url === "string") {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      // "noopener" would return no handle to point at the address later.
      const tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
      try {
        const address = await url;
        if (tab) tab.location.replace(address);
        else window.open(address, "_blank", "noopener,noreferrer");
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    navigate: (url) => location.assign(url),
    writeClipboard,
    microphonePermission: async () => {
      try {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        return status.state;
      } catch {
        return "prompt";
      }
    },
    platformHint: nav?.userAgentData?.platform || nav?.userAgent || "",
    onVisibility: (listener) => {
      const report = () =>
        listener(document.visibilityState === "visible", document.hasFocus());
      document.addEventListener("visibilitychange", report);
      window.addEventListener("focus", report);
      window.addEventListener("blur", report);
    },
    onOnline: (listener) => window.addEventListener("online", listener),
    development: Boolean(import.meta.env?.DEV),
    sessionValue: (key) => {
      try {
        return sessionStorage.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    setSessionValue: (key, value) => {
      try {
        if (value === undefined) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
      } catch {
        // Storage blocked: the tab forgets its account on a reload.
      }
    },
    localValue: (key) => {
      try {
        return localStorage.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    setLocalValue: (key, value) => {
      try {
        if (value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Storage blocked: no remembered accounts in this browser.
      }
    },
    // The ceremony's code loads when someone signs in with a passkey.
    ...("PublicKeyCredential" in window && nav?.credentials
      ? {
          passkey: async (options: unknown) =>
            (await import("./passkey")).passkeyAssertion(options),
          passkeyCreate: async (options: unknown) =>
            (await import("./passkey")).passkeyAttestation(options),
        }
      : {}),
  };
}
