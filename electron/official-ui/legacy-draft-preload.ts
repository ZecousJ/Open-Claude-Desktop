import { ipcRenderer } from "electron";

const chatPrefix = "store:chat-draft:";
const codePrefix = "composer-draft:";
const chatBlobPrefix = "store:attachment-blob:";
const codeImagePrefix = "composer-draft-images:";
const confirmedAccountKey = "rq-cache-confirmed-account";
const reactPrefix = "claudex:composer-draft:v1:";

export interface LegacyDraftIndex {
  kind: "chat" | "code";
  key: string;
  updatedAt: number;
}

export interface ReactComposerDraft {
  place: string;
  text: string;
  updatedAt: number;
}

export type LegacyDraftRequest =
  | { type: "index"; owner: string }
  | { type: "read-react"; owner: string }
  | {
      type: "import-react";
      owner: string;
      rows: { row: LegacyDraftIndex; text: string }[];
    }
  | {
      type: "export" | "import";
      owner: string;
      row: LegacyDraftIndex;
    };

interface DraftPayload {
  record: unknown;
  blobs?: { key: string; bytes: ArrayBuffer; type: string }[];
  images?: [string, unknown[]];
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function own(value: unknown, owner: string) {
  const row = record(value);
  return row?.owner === owner ? row : undefined;
}

function time(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function reactDrafts(owner: string): ReactComposerDraft[] {
  const prefix = `${reactPrefix}${owner}:`;
  const drafts: ReactComposerDraft[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const draft = record(localStorage.getItem(key));
    if (typeof draft?.text === "string" && draft.text.trim())
      drafts.push({
        place: key.slice(prefix.length),
        text: draft.text,
        updatedAt: time(draft.storedAt),
      });
  }
  return drafts;
}

function reactPayload(
  owner: string,
  { kind, updatedAt }: LegacyDraftIndex,
  text: string,
): DraftPayload {
  if (kind === "code")
    return { record: JSON.stringify({ owner, text, storedAt: updatedAt }) };
  return {
    record: {
      owner,
      updatedAt,
      version: 2,
      state: {
        tipTapEditorState: {
          type: "doc",
          content: text.split("\n").map((line) => ({
            type: "paragraph",
            content: line ? [{ type: "text", text: line }] : [],
          })),
        },
        files: [],
      },
    },
  };
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function keyval(create = false) {
  if (
    !create &&
    !(await indexedDB.databases()).some((db) => db.name === "keyval-store")
  )
    return;
  const request = indexedDB.open("keyval-store");
  request.onupgradeneeded = () => request.result.createObjectStore("keyval");
  return result(request);
}

async function draftIndex(owner: string): Promise<LegacyDraftIndex[]> {
  const rows: LegacyDraftIndex[] = [];
  const db = await keyval();
  if (db) {
    try {
      const store = db.transaction("keyval", "readonly").objectStore("keyval");
      const keys = await result(
        store.getAllKeys(
          IDBKeyRange.bound(chatPrefix, "store:chat-draft;", false, true),
        ),
      );
      for (const key of keys) {
        if (typeof key !== "string" || !key.startsWith(chatPrefix)) continue;
        const draft = own(await result(store.get(key)), owner);
        if (record(draft?.state))
          rows.push({ kind: "chat", key, updatedAt: time(draft?.updatedAt) });
      }
    } finally {
      db.close();
    }
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(codePrefix)) continue;
    const draft = own(localStorage.getItem(key), owner);
    if (draft)
      rows.push({
        kind: "code",
        key,
        updatedAt: Math.max(time(draft.storedAt), time(draft.textChangedAt)),
      });
  }
  return rows;
}

function chatBlobKeys(state: Record<string, unknown>) {
  const keys = new Set<string>();
  const include = (files: unknown) => {
    if (!Array.isArray(files)) return;
    for (const file of files) {
      const id = record(file)?.file_uuid;
      if (typeof id === "string" && id) keys.add(chatBlobPrefix + id);
    }
  };
  include(state.files);
  if (Array.isArray(state.queuedMessages))
    for (const message of state.queuedMessages) include(record(message)?.files);
  return keys;
}

async function exportDraft(
  row: LegacyDraftIndex,
  owner: string,
): Promise<DraftPayload | undefined> {
  const db = await keyval();
  try {
    const store = db?.transaction("keyval", "readonly").objectStore("keyval");
    if (row.kind === "code") {
      const raw = localStorage.getItem(row.key);
      if (!own(raw, owner)) return;
      const key = codeImagePrefix + row.key.slice(codePrefix.length);
      const images = store && (await result(store.get(key)));
      const ownedImages = Array.isArray(images)
        ? images.filter((item) => own(item, owner))
        : [];
      return {
        record: raw,
        ...(ownedImages.length ? { images: [key, ownedImages] } : {}),
      };
    }
    if (!store) return;
    const raw = await result(store.get(row.key));
    const state = record(own(raw, owner)?.state);
    if (!state) return;
    const attachments: { key: string; blob: Blob }[] = [];
    for (const key of chatBlobKeys(state)) {
      const blob = await result(store.get(key));
      if (blob instanceof Blob) attachments.push({ key, blob });
    }
    // Chromium Blob handles are bound to their source storage partition.
    const blobs = await Promise.all(
      attachments.map(async ({ key, blob }) => ({
        key,
        bytes: await blob.arrayBuffer(),
        type: blob.type,
      })),
    );
    return { record: raw, blobs };
  } finally {
    db?.close();
  }
}

async function importDraft(
  row: LegacyDraftIndex,
  owner: string,
  payload: DraftPayload | undefined,
) {
  if (!payload || !own(payload.record, owner)) return;
  if (row.kind === "code" && localStorage.getItem(row.key) !== null) return;
  const storedOwner = localStorage.getItem(confirmedAccountKey);
  if (storedOwner !== null && storedOwner !== owner)
    throw new Error("The draft partition belongs to another account.");
  // The recovered first-login code clears drafts when the partition has no
  // account attribution. This partition and the imported record share the
  // desktop host's authenticated owner before the original page opens.
  if (storedOwner === null) localStorage.setItem(confirmedAccountKey, owner);
  const db = (await keyval(true))!;
  try {
    const tx = db.transaction("keyval", "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const store = tx.objectStore("keyval");
    const available =
      row.kind === "code" ||
      (await result(store.getKey(row.key))) === undefined;
    if (available) {
      for (const { key, bytes, type } of payload.blobs ?? []) {
        if ((await result(store.getKey(key))) === undefined)
          store.add(new Blob([bytes], { type }), key);
      }
      if (
        payload.images &&
        (await result(store.getKey(payload.images[0]))) === undefined
      )
        store.add(payload.images[1], payload.images[0]);
      if (row.kind === "chat") store.add(payload.record, row.key);
    }
    await done;
    if (
      row.kind === "code" &&
      typeof payload.record === "string" &&
      localStorage.getItem(row.key) === null
    )
      localStorage.setItem(row.key, payload.record);
  } finally {
    db.close();
  }
}

ipcRenderer.on(
  "claudex:legacy-drafts",
  async (event, request: LegacyDraftRequest) => {
    const [reply, peer] = event.ports;
    try {
      if (request.type === "index") {
        reply.postMessage({ ok: true, value: await draftIndex(request.owner) });
      } else if (request.type === "read-react") {
        reply.postMessage({ ok: true, value: reactDrafts(request.owner) });
      } else if (request.type === "import-react") {
        for (const { row, text } of request.rows)
          await importDraft(
            row,
            request.owner,
            reactPayload(request.owner, row, text),
          );
        reply.postMessage({ ok: true });
      } else if (request.type === "export") {
        const payload = await exportDraft(request.row, request.owner);
        peer.postMessage(
          payload,
          payload?.blobs?.map(({ bytes }) => bytes) ?? [],
        );
        reply.postMessage({ ok: true });
      } else {
        const payload = await new Promise<DraftPayload | undefined>(
          (resolve) => {
            peer.onmessage = (message) => resolve(message.data);
          },
        );
        await importDraft(request.row, request.owner, payload);
        reply.postMessage({ ok: true });
      }
    } catch {
      reply.postMessage({ ok: false });
    } finally {
      reply.close();
      peer?.close();
    }
  },
);
