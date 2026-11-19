const accountStoragePrefix = (account: string) => `claudex:official:${encodeURIComponent(account)}:`;

export function forgetOfficialAccountDrafts(
  host: Pick<Window, "localStorage" | "sessionStorage" | "indexedDB">,
  account: string,
) {
  const prefix = accountStoragePrefix(account);
  try {
    const local = host.localStorage;
    for (let index = local.length - 1; index >= 0; index--) {
      const key = local.key(index);
      if (!key?.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (name === "static-composer-draft-data" || name.startsWith("composer-draft:") ||
          /^LSS-.*:(?:textInput|attachment|files|syncSourceUuids)$/.test(name))
        local.removeItem(key);
    }
    host.sessionStorage.removeItem(prefix + "claudex:pending-code-send");
  } catch {
    // The browser may disable storage for this page.
  }
  try {
    const request = host.indexedDB.open(prefix + "keyval-store");
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => {
      const db = request.result;
      if (db.objectStoreNames.contains("keyval")) {
        const store = db.transaction("keyval", "readwrite").objectStore("keyval");
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (typeof row.key === "string" && /^(?:store:(?:chat-draft|attachment-blob|draft-stash)|composer-draft-images)(?::|-|$)/.test(row.key))
            row.delete();
          row.continue();
        };
      }
      db.close();
    };
  } catch {
    // The browser may disable IndexedDB for this page.
  }
}

export function seedOfficialComposerLayout(storage: Storage, seed: unknown) {
  if (seed !== "marlin") return;
  try {
    if (storage.getItem("composer-card-latch") === null)
      storage.setItem("composer-card-latch", seed);
  } catch {
    // Storage may be unavailable; the original UI handles that case.
  }
}

/** Give the recovered document the same account storage boundary as desktop partitions. */
export function bindOfficialAccountStorage(
  frame: Window & typeof globalThis,
  account: string,
  onLocalWrite?: (key: string, value: string) => void,
) {
  const prefix = accountStoragePrefix(account);
  const areas = new Map<Storage, Storage>();
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const source = frame[name];
    const keys = () =>
      Array.from({ length: source.length }, (_, i) => source.key(i)!)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    const methods = {
      getItem: (key: string) => source.getItem(prefix + String(key)),
      setItem: (key: string, value: string) => {
        source.setItem(prefix + String(key), String(value));
        if (name === "localStorage") onLocalWrite?.(String(key), String(value));
      },
      removeItem: (key: string) => source.removeItem(prefix + String(key)),
      key: (index: number) => keys()[index] ?? null,
      clear: () => {
        for (const key of keys()) source.removeItem(prefix + key);
      },
    };
    const scoped = new Proxy(source, {
      get: (_target, key) =>
        key === "length"
          ? keys().length
          : Object.hasOwn(methods, key)
            ? methods[key as keyof typeof methods]
            : typeof key === "string"
              ? methods.getItem(key)
              : Reflect.get(source, key),
      set: (_target, key, value) => {
        methods.setItem(String(key), String(value));
        return true;
      },
      deleteProperty: (_target, key) => {
        methods.removeItem(String(key));
        return true;
      },
      ownKeys: keys,
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === "string" && keys().includes(key)
          ? {
              value: methods.getItem(key),
              configurable: true,
              enumerable: true,
              writable: true,
            }
          : undefined,
    });
    areas.set(source, scoped);
    Object.defineProperty(frame, name, { value: scoped, configurable: true });
  }
  const indexed = frame.indexedDB;
  Object.defineProperty(frame, "indexedDB", {
    configurable: true,
    value: new Proxy(indexed, {
      get(target, key) {
        if (key === "open" || key === "deleteDatabase")
          return (name: string, ...args: unknown[]) =>
            Reflect.apply(target[key], target, [
              prefix + String(name),
              ...args,
            ]);
        if (key === "databases" && typeof target.databases === "function")
          return async () =>
            (await target.databases())
              .filter((database) => database.name?.startsWith(prefix))
              .map((database) => ({
                ...database,
                name: database.name!.slice(prefix.length),
              }));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  const onStorage = (event: StorageEvent) => {
    const scoped = event.storageArea && areas.get(event.storageArea);
    if (!scoped) return;
    event.stopImmediatePropagation();
    if (event.key !== null && !event.key.startsWith(prefix)) return;
    const forwarded = new frame.StorageEvent("storage", {
      key: event.key?.slice(prefix.length) ?? null,
      newValue: event.newValue,
      oldValue: event.oldValue,
      url: event.url,
    });
    Object.defineProperty(forwarded, "storageArea", { value: scoped });
    frame.dispatchEvent(forwarded);
  };
  frame.addEventListener("storage", onStorage, true);
  return () => frame.removeEventListener("storage", onStorage, true);
}
