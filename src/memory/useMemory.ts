import { useEffect, useRef, useState } from "react";
import type {
  MemoryPrefs,
  MemoryScopeRef,
  MemoryStatus,
} from "../../shared/memory-api";

/**
 * The wording the main process uses (electron/memory/types.ts
 * `memoryMessages`), repeated because the renderer does not import from
 * electron/. `server` is design 4.1's wording for a service without memory
 * set up.
 */
export const memoryText = {
  unsupported: "Memory isn't available on this server yet.",
  server: "Memory needs the server to be set up by your administrator.",
  disabled: "Memory is turned off by your administrator.",
  switchDisabled: "Turned off by your administrator.",
  offline: "You're offline. Changes will be available when you reconnect.",
  conflict: "Memory changed on another device.",
} as const;

/** The View and edit counter's limit (design 4.1). */
export const memoryDocChars = 16_000;
/** The service's own limit, in UTF-8 bytes (memoryLimits.docBytes). */
export const memoryDocBytes = 16 * 1024;
/** Longest text Import memory accepts (maxImportBytes). */
export const memoryImportBytes = 32 * 1024;

export const utf8Bytes = (text: string) =>
  new TextEncoder().encode(text).length;

/** Whether a document can be saved: within both the counter and the service's limit. */
export const memoryFits = (text: string) =>
  text.length <= memoryDocChars && utf8Bytes(text) <= memoryDocBytes;

/** Drops Electron's "Error invoking remote method" prefix. */
export function memoryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}

/** A save refused because another device changed memory first. */
export const isConflict = (error: unknown) =>
  /changed on another device/i.test(memoryError(error));

export const globalScope: MemoryScopeRef = { kind: "global" };

/**
 * Memory status for Settings and the project page: read once, again on
 * every "memory-changed", and a switch changes at once (optimistic), going
 * back when the main process refuses.
 */
export function useMemory(onError: (error: unknown) => void) {
  const [status, setStatus] = useState<MemoryStatus>();
  const [failed, setFailed] = useState(false);
  // A reply to an older read must not replace a newer state.
  const reads = useRef(0);
  const reload = () => {
    const read = ++reads.current;
    return window.desktop
      .memoryStatus()
      .then((value) => {
        if (read !== reads.current) return;
        setStatus(value);
        setFailed(false);
      })
      .catch((error) => {
        if (read !== reads.current) return;
        setFailed(true);
        onError(error);
      });
  };
  useEffect(() => {
    void reload();
    return window.desktop.onEvent((event) => {
      if (event.type === "memory-changed") void reload();
    });
  }, []);
  const setPrefs = (change: Partial<MemoryPrefs>) => {
    if (!status) return;
    const before = status;
    const read = ++reads.current;
    setStatus({ ...status, prefs: { ...status.prefs, ...change } });
    void window.desktop
      .setMemoryPrefs(change)
      .then((value) => {
        if (read === reads.current) setStatus(value);
      })
      .catch((error) => {
        if (read === reads.current) setStatus(before);
        onError(error);
      });
  };
  /** A status a dialog's change returned. */
  const update = (value: MemoryStatus) => {
    reads.current++;
    setStatus(value);
  };
  return { status, failed, reload, setPrefs, update };
}
