import { z } from "zod";

const database = "keyval-store";
const storeName = "keyval";
const chatPrefix = "store:chat-draft:";
const blobPrefix = "store:attachment-blob:";
const codePrefix = "composer-draft:";
const imagePrefix = "composer-draft-images:";
const confirmedAccount = "rq-cache-confirmed-account";
const editorPrefs = "epitaxy-editor-prefs";
const migratedDraftRows = "claudex:legacy-draft-migration:v1";
const ownerSchema = z.object({ owner: z.string() });
const objectSchema = z.record(z.string(), z.unknown());
const chatSchema = z.object({ owner: z.string(), state: objectSchema });
const codeSchema = z.object({ owner: z.string(), text: z.string(), snippets: z.array(z.unknown()).optional() }).passthrough();
const preferencesSchema = z.object({
  version: z.literal(0),
  state: z.object({
    editorFont: z.string().max(200).optional(),
    codeFontSize: z.number().finite().nullable().optional(),
    codeThemeLight: z.string().max(200).optional(),
    codeThemeDark: z.string().max(200).optional(),
    chatTextSize: z.enum(["s", "m", "l"]).optional(),
    transcriptWidthChoice: z.enum(["s", "m", "l"]).nullable().optional(),
    transcriptWidth: z.enum(["s", "m", "l"]).optional(),
  }),
});

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function open(factory: IDBFactory, signal: AbortSignal, create: boolean) {
  signal.throwIfAborted();
  return new Promise<IDBDatabase | undefined>((resolve, reject) => {
    const request = factory.open(database);
    let absent = false;
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const detach = () => signal.removeEventListener("abort", abort);
    request.onupgradeneeded = () => {
      if (!create || signal.aborted) {
        absent = !create;
        request.transaction?.abort();
      } else request.result.createObjectStore(storeName);
    };
    request.onsuccess = () => {
      detach();
      if (signal.aborted || !request.result.objectStoreNames.contains(storeName)) {
        request.result.close();
        resolve(undefined);
      } else resolve(request.result);
    };
    request.onerror = () => {
      detach();
      if (absent) resolve(undefined);
      else reject(request.error);
    };
  });
}

function chatFiles(state: Record<string, unknown>) {
  const files = new Set<string>();
  const include = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const row of value) {
      const id = objectSchema.safeParse(row).data?.file_uuid;
      if (typeof id === "string" && id.length <= 512 && id) files.add(blobPrefix + id);
    }
  };
  include(state.files);
  if (Array.isArray(state.queuedMessages))
    for (const message of state.queuedMessages)
      include(objectSchema.safeParse(message).data?.files);
  return files;
}

export async function migrateOfficialAccountStorage({
  source, target, owner, organization, signal, current,
}: {
  source: { localStorage: Storage; indexedDB: IDBFactory };
  target: { localStorage: Storage; indexedDB: IDBFactory };
  owner: string;
  organization: string;
  signal: AbortSignal;
  current(): boolean;
}) {
  const marker = "claudex:official-migration:v1:" + encodeURIComponent(owner);
  const check = () => {
    signal.throwIfAborted();
    if (!current()) throw new DOMException("The account changed.", "AbortError");
  };
  check();
  if (source.localStorage.getItem(marker) === "done") return;
  const confirmed = target.localStorage.getItem(confirmedAccount);
  if (confirmed !== null && confirmed !== owner) return;

  const code = new Map<string, string>();
  for (let i = 0; i < source.localStorage.length; i++) {
    const key = source.localStorage.key(i);
    if (!key?.startsWith(codePrefix) || key.length > 512 ||
        target.localStorage.getItem(key) !== null) continue;
    const raw = source.localStorage.getItem(key);
    if (raw === null || raw.length > 262_144) continue;
    const draft = codeSchema.safeParse(json(raw)).data;
    if (draft?.owner !== owner) continue;
    const snippets = draft.snippets?.filter(snippet => {
      const storedOwner = ownerSchema.safeParse(snippet).data?.owner;
      return storedOwner === undefined || storedOwner === owner;
    });
    code.set(key, snippets?.length === draft.snippets?.length ? raw : JSON.stringify({ ...draft, snippets }));
  }

  const legacy = await open(source.indexedDB, signal, false);
  const rows = new Map<string, { value: unknown; sidecars: Map<string, unknown> }>();
  if (legacy) {
    const tx = legacy.transaction(storeName, "readonly");
    const abort = () => { try { tx.abort(); } catch {} };
    signal.addEventListener("abort", abort, { once: true });
    try {
      check();
      const store = tx.objectStore(storeName);
      const range = IDBKeyRange.bound(chatPrefix, "store:chat-draft;", false, true);
      const keys = await result(store.getAllKeys(range, 1001));
      if (keys.length > 1000) throw Error("Legacy draft index is too large.");
      const chat = new Map<string, { raw: unknown; blobs: Set<string> }>();
      const foreignBlobs = new Set<string>();
      for (const key of keys) {
        if (typeof key !== "string" || key.length > 512) continue;
        const raw: unknown = await result(store.get(key));
        const row = objectSchema.safeParse(json(raw)).data;
        const state = objectSchema.safeParse(row?.state).data;
        if (!state) continue;
        const blobs = chatFiles(state);
        if (chatSchema.safeParse(row).data?.owner === owner)
          chat.set(key, { raw, blobs });
        else for (const blob of blobs) foreignBlobs.add(blob);
      }
      for (const [key, draft] of chat) {
        // Bare blobs have only draft references for ownership.
        if ([...draft.blobs].some(blob => foreignBlobs.has(blob))) continue;
        const sidecars = new Map<string, unknown>();
        for (const blob of draft.blobs) {
          const value: unknown = await result(store.get(blob));
          if (value instanceof Blob) sidecars.set(blob, value);
        }
        rows.set(key, { value: draft.raw, sidecars });
      }
      for (const key of code.keys()) {
        const imageKey = imagePrefix + key.slice(codePrefix.length);
        const images: unknown = await result(store.get(imageKey));
        if (!Array.isArray(images)) continue;
        const owned = images.filter(image => ownerSchema.safeParse(image).data?.owner === owner);
        if (owned.length) rows.set(imageKey, { value: owned, sidecars: new Map() });
      }
    } finally {
      signal.removeEventListener("abort", abort);
      legacy.close();
    }
  }
  check();

  if (rows.size) {
    const db = await open(target.indexedDB, signal, true);
    try {
      check();
      if (!db) throw Error("Account draft storage is unavailable.");
      const tx = db.transaction(storeName, "readwrite");
      const abort = () => { try { tx.abort(); } catch {} };
      signal.addEventListener("abort", abort, { once: true });
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? signal.reason);
      });
      void done.catch(() => {});
      try {
        const store = tx.objectStore(storeName);
        const migrated = await result(store.getKey(migratedDraftRows));
        check();
        if (migrated === undefined) {
          for (const [key, { value, sidecars }] of rows) {
            const present = await result(store.getKey(key));
            check();
            if (present !== undefined) continue;
            await result(store.add(value, key));
            for (const [name, blob] of sidecars) {
              const existing = await result(store.getKey(name));
              check();
              if (existing === undefined) await result(store.add(blob, name));
            }
          }
          check();
          await result(store.add(true, migratedDraftRows));
        }
        await done;
      } catch (error) {
        abort();
        throw error;
      } finally { signal.removeEventListener("abort", abort); }
    } finally { db?.close(); }
  }
  check();

  const writes = new Map(code);
  if (rows.size || code.size) writes.set(confirmedAccount, owner);
  const voucher = source.localStorage.getItem("ccd-sync-pending:ccd/" + editorPrefs);
  if (voucher?.replace(/\|migrate$/, "") === `${owner}/${organization}`) {
    const raw = source.localStorage.getItem(editorPrefs);
    if (raw && raw.length <= 4096) {
      const preferences = preferencesSchema.safeParse(json(raw));
      if (preferences.success) writes.set(editorPrefs, JSON.stringify(preferences.data));
    }
  }
  const applied = new Map<string, string>();
  try {
    for (const [key, raw] of writes) {
      if (target.localStorage.getItem(key) !== null) continue;
      target.localStorage.setItem(key, raw);
      applied.set(key, raw);
    }
    source.localStorage.setItem(marker, "done");
  } catch (error) {
    for (const [key, raw] of applied)
      if (target.localStorage.getItem(key) === raw) target.localStorage.removeItem(key);
    throw error;
  }
}
