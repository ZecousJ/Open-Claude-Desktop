import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, MessageChannelMain, session } from "electron";
import { uiHost, uiScheme } from "../../shared/ui-pack";
import { readSavedUiPort } from "./account-browser-storage";
import type {
  LegacyDraftIndex,
  LegacyDraftRequest,
  ReactComposerDraft,
} from "./legacy-draft-preload";

const migrationPage = "/__claudex_draft_migration";
const channel = "claudex:legacy-drafts";

function legacyOrigins(userData: string) {
  const directory = path.join(
    userData,
    "Partitions",
    "official-ui",
    "IndexedDB",
  );
  if (!fs.existsSync(path.dirname(directory))) return [];
  const ports = new Set<number>();
  const saved = readSavedUiPort(path.join(userData, "official-ui-server-port"));
  if (saved) ports.add(saved);
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const match = /^http_localhost_(\d+)\.indexeddb\.leveldb$/.exec(
        entry.name,
      );
      const port = Number(match?.[1]);
      if (entry.isDirectory() && port >= 1024 && port <= 65535) ports.add(port);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Array.from(ports, (port) => `http://localhost:${port}`);
}

function draftWindow(browserSession: Electron.Session, preload: string) {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      preload,
    },
  });
}

function requestPage<T>(
  win: BrowserWindow,
  request: LegacyDraftRequest,
  ports: Electron.MessagePortMain[] = [],
) {
  const { port1, port2 } = new MessageChannelMain();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Draft storage did not respond.")),
      10_000,
    );
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timeout);
      win.removeListener("closed", closed);
      port1.close();
      if (error) reject(error);
      else resolve(value as T);
    };
    const closed = () => finish(new Error("Draft storage window closed."));
    win.once("closed", closed);
    port1.once("message", ({ data }) => {
      if (data?.ok === true) finish(undefined, data.value);
      else finish(new Error("Draft storage could not be read or saved."));
    });
    port1.start();
    try {
      win.webContents.postMessage(channel, request, [port2, ...ports]);
    } catch (error) {
      finish(
        error instanceof Error
          ? error
          : new Error("Draft storage is unavailable."),
      );
    }
  });
}

export interface DraftDestination {
  kind: LegacyDraftIndex["kind"];
  id: string;
}

interface MigrationOptions {
  userData: string;
  marker: string;
  targetSession: Electron.Session;
  targetOrigin: string;
  owner: string;
  preload: string;
  conversationDrafts(
    ids: string[],
    refresh: boolean,
  ): Promise<Map<string, DraftDestination>>;
  current(): boolean;
}

// The former partition is shared. Only one account may inspect it at a time.
let legacyAccess = Promise.resolve();
export function restoreLegacyDrafts(options: MigrationOptions) {
  const work = legacyAccess.then(async () => {
    await restore(options);
    await restoreReactDrafts(options);
  });
  legacyAccess = work.catch(() => undefined);
  return work;
}

function installPage(browserSession: Electron.Session, permitted: Set<string>) {
  browserSession.protocol.handle("http", ({ url }) => {
    const address = new URL(url);
    return address.pathname === migrationPage && permitted.has(address.origin)
      ? new Response("<!doctype html><title>Claudex</title>", {
          headers: {
            "Content-Type": "text/html",
            "Content-Security-Policy": "default-src 'none'",
          },
        })
      : new Response(null, { status: 404 });
  });
  return () => browserSession.protocol.unhandle("http");
}

async function restoreReactDrafts(options: MigrationOptions) {
  const {
    marker,
    targetSession,
    targetOrigin,
    owner,
    preload,
    current,
    conversationDrafts,
  } = options;
  const reactMarker = `${marker}-react`;
  if (!current()) return;
  const progress = fs.existsSync(reactMarker)
    ? fs.readFileSync(reactMarker, "utf8")
    : undefined;
  if (progress === "complete\n") return;
  const processed = new Set<string>(progress ? JSON.parse(progress) : []);
  const sourceSession = session.defaultSession;
  const source = draftWindow(sourceSession, preload);
  const newest = new Map<string, ReactComposerDraft>();
  const readDrafts = async () => {
    for (const draft of await requestPage<ReactComposerDraft[]>(source, {
      type: "read-react",
      owner,
    })) {
      if (processed.has(draft.place)) continue;
      const previous = newest.get(draft.place);
      if (!previous || draft.updatedAt > previous.updatedAt)
        newest.set(draft.place, draft);
    }
  };
  try {
    if (sourceSession.protocol.isProtocolHandled(uiScheme)) {
      await source.loadURL(`${uiScheme}://${uiHost}/__blank`);
      if (!current()) return;
      await readDrafts();
    }
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-react-drafts-"),
    );
    try {
      const blank = path.join(directory, "index.html");
      fs.writeFileSync(blank, "<!doctype html><title>Claudex</title>");
      await source.loadFile(blank);
      if (!current()) return;
      await readDrafts();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    if (!source.isDestroyed()) source.destroy();
  }
  if (!current()) return;
  const saveProgress = () => {
    const temporary = `${reactMarker}.tmp`;
    fs.writeFileSync(
      temporary,
      newest.size ? JSON.stringify([...processed]) : "complete\n",
    );
    fs.renameSync(temporary, reactMarker);
  };
  const importPlaces = async (destinations: Map<string, DraftDestination>) => {
    const rows = Array.from(newest.values()).flatMap(
      ({ place, text, updatedAt }) => {
        const destination = destinations.get(place);
        if (!destination) return [];
        const { kind, id } = destination;
        const key =
          (kind === "chat" ? "store:chat-draft:" : "composer-draft:") + id;
        return [{ place, row: { kind, key, updatedAt }, text }];
      },
    );
    if (!rows.length || !current()) return;
    const cleanup = installPage(targetSession, new Set([targetOrigin]));
    let target: BrowserWindow | undefined;
    try {
      target = draftWindow(targetSession, preload);
      await target.loadURL(targetOrigin + migrationPage);
      if (!current()) return;
      await requestPage<void>(target, { type: "import-react", owner, rows });
      if (!current()) return;
      for (const { place } of rows) {
        processed.add(place);
        newest.delete(place);
      }
      saveProgress();
    } finally {
      if (target && !target.isDestroyed()) target.destroy();
      cleanup();
    }
  };
  if (!newest.size) {
    saveProgress();
    return;
  }
  const destinations = new Map<string, DraftDestination>([
    ["new:chat", { kind: "chat", id: "chorus-unified-composer" }],
    ["new:code", { kind: "code", id: "epitaxy-draft" }],
  ]);
  const ids = Array.from(newest.keys()).filter(
    (place) => !destinations.has(place),
  );
  if (ids.length)
    for (const [place, destination] of await conversationDrafts(ids, false))
      destinations.set(place, destination);
  await importPlaces(destinations);
  if (!current() || !newest.size) return;
  await importPlaces(await conversationDrafts([...newest.keys()], true));
}

async function restore(options: MigrationOptions) {
  const {
    userData,
    marker,
    targetSession,
    targetOrigin,
    owner,
    preload,
    current,
  } = options;
  if (!current() || fs.existsSync(marker)) return;
  const origins = legacyOrigins(userData);
  if (!origins.length) return;

  const sourceSession = session.fromPartition("persist:official-ui");
  const cleanupSource = installPage(sourceSession, new Set(origins));
  let source: BrowserWindow | undefined;
  let target: BrowserWindow | undefined;
  let cleanupTarget: (() => void) | undefined;
  try {
    source = draftWindow(sourceSession, preload);
    const newest = new Map<string, LegacyDraftIndex & { origin: string }>();
    for (const origin of origins) {
      if (!current()) return;
      await source.loadURL(origin + migrationPage);
      const index = await requestPage<LegacyDraftIndex[]>(source, {
        type: "index",
        owner,
      });
      for (const row of index) {
        const key = `${row.kind}:${row.key}`;
        const previous = newest.get(key);
        if (!previous || row.updatedAt > previous.updatedAt)
          newest.set(key, { ...row, origin });
      }
    }
    if (!current()) return;
    if (newest.size) {
      cleanupTarget = installPage(targetSession, new Set([targetOrigin]));
      target = draftWindow(targetSession, preload);
      await target.loadURL(targetOrigin + migrationPage);
      const byOrigin = new Map<string, LegacyDraftIndex[]>();
      for (const { origin, ...row } of newest.values()) {
        const rows = byOrigin.get(origin) ?? [];
        rows.push(row);
        byOrigin.set(origin, rows);
      }
      for (const [origin, rows] of byOrigin) {
        if (!current()) return;
        await source.loadURL(origin + migrationPage);
        for (const row of rows) {
          if (!current()) return;
          const { port1, port2 } = new MessageChannelMain();
          await Promise.all([
            requestPage<void>(target, { type: "import", owner, row }, [port1]),
            requestPage<void>(source, { type: "export", owner, row }, [port2]),
          ]);
        }
      }
    }
    if (current()) fs.writeFileSync(marker, "complete\n");
  } finally {
    if (target && !target.isDestroyed()) target.destroy();
    cleanupTarget?.();
    if (source && !source.isDestroyed()) source.destroy();
    cleanupSource();
  }
}
