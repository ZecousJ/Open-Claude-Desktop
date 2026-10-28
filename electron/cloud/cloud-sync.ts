/**
 * The desktop's cloud conversations (docs/cloud-sync.md P4): the cloud
 * client (P3) while a Claudex account is signed in and sync is on
 * (Settings, on by default), and the router in front of the IPC handlers.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app, BrowserWindow, powerMonitor, shell } from "electron";
import type { AppEvent, Attachment } from "../../shared/types";
import { CloudClient, type CloudSession } from "./cloud-client";
import { RoutineMigrationRegistry } from "./routine-migration-registry";
import { CloudRouter } from "./cloud-router";
import { moveToCloud, type MoveDeps } from "./migrate";
import { githubRoutes } from "../../shared/github-api";
import type { ChatGitHubRead } from "../../shared/chat-github";
import { deviceLinkId, deviceName } from "../remote-control/device-identity";

export interface CloudSyncOptions {
  /** The Claudex service's address; undefined while signed out. */
  baseUrl(): string | undefined;
  /** The signed-in account's session; undefined while signed out. */
  session(): CloudSession | undefined;
  /** The person's "sync with the web" switch. */
  enabled(): boolean;
  push(event: AppEvent): void;
  /** An attachment this app picked (main.ts keeps the list). */
  attachment(id: string): Attachment | undefined;
  /** The signed-in profile's store (its conversations move to the cloud). */
  localStore(): MoveDeps["store"] | undefined;
  /** The Chat permission mode this computer's picker shows. */
  taskPermission?(): "default" | "auto" | "bypass" | undefined;
}

export type CloudSync = ReturnType<typeof createCloudSync>;

/** The pending link claims, in the account's folder (CloudRouterDeps.claims). */
function linkClaims(root: () => string | undefined) {
  const file = () => {
    const folder = root();
    return folder ? path.join(folder, "link-claims.json") : undefined;
  };
  const read = (): string[] => {
    const target = file();
    if (!target) return [];
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf8"));
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  };
  const write = (ids: string[]) => {
    const target = file();
    if (!target) return;
    if (ids.length) fs.writeFileSync(target, JSON.stringify(ids));
    else fs.rmSync(target, { force: true });
  };
  return {
    list: read,
    add: (id: string) => write([...new Set([...read(), id])]),
    remove: (id: string) => write(read().filter((value) => value !== id)),
  };
}

export function createCloudSync(options: CloudSyncOptions) {
  let client: CloudClient | undefined;
  let clientBase: string | undefined;
  let clientProfile: string | undefined;
  let clientSession: CloudSession | undefined;
  let clientLease: object | undefined;
  const migrationJournals = new Map<string, RoutineMigrationRegistry>();
  let unsubscribe: (() => void) | undefined;
  const visibility = new Set<(visible: boolean, focused: boolean) => void>();
  const online = new Set<() => void>();
  const report = () => {
    const windows = BrowserWindow.getAllWindows();
    const visible = windows.some((w) => w.isVisible() && !w.isMinimized());
    const focused = windows.some((w) => w.isFocused());
    for (const listener of visibility) listener(visible, focused);
  };
  app.on("browser-window-focus", report);
  app.on("browser-window-blur", report);
  powerMonitor.on("resume", () => {
    for (const listener of online) listener();
  });

  // The local Chat and Cowork conversations move once per sign-in (P5).
  let moving: Promise<unknown> | undefined;
  const move = () => {
    const store = options.localStore();
    const current = client;
    if (moving || !store || !current) return;
    moving = moveToCloud({
      store,
      call: (method, args) => current.call(method, args),
      inCloud: (id) => router.isCloudConversation(id),
    })
      .then(({ moved }) => {
        if (moved && client === current) options.push({ type: "resync" });
      })
      .catch((error) =>
        console.error(
          "Moving conversations to the cloud:",
          error instanceof Error ? error.message : String(error),
        ),
      );
  };

  const stop = () => {
    moving = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    client?.stop();
    client = undefined;
    clientBase = undefined;
    clientProfile = undefined;
    clientSession = undefined;
    clientLease = undefined;
    router.reset();
  };

  /** The running client, started on first use; undefined while off. */
  const active = (forDeletion = false): CloudClient | undefined => {
    const base = options.baseUrl();
    const profile = options.localStore()?.root;
    const session = options.session();
    if (!base || (!forDeletion && !options.enabled()) || !session) {
      if (client) stop();
      return undefined;
    }
    if (
      client &&
      clientBase === base &&
      clientProfile === profile &&
      clientSession === session
    )
      return client;
    stop();
    clientBase = base;
    clientProfile = profile;
    clientSession = session;
    const lease = {};
    clientLease = lease;
    client = new CloudClient({
      baseUrl: base,
      // A retired request must never acquire another profile's token while
      // awaiting transport/refresh; the next client has a different lease.
      session: () =>
        clientLease === lease &&
        options.session() === session &&
        options.localStore()?.root === profile &&
        options.baseUrl() === base
          ? session
          : undefined,
      randomId: () => `desktop-${randomUUID()}`,
      openUrl: (url) => {
        if (/^https:\/\//i.test(url)) void shell.openExternal(url);
      },
      onVisibility: (listener) => visibility.add(listener),
      onOnline: (listener) => online.add(listener),
    });
    unsubscribe = client.onEvent((event) => router.cloudEvent(event));
    client.start();
    return client;
  };

  const router = new CloudRouter({
    client: active,
    push: options.push,
    attachmentBytes: async (id) => {
      const attachment = options.attachment(id);
      if (!attachment) return undefined;
      const data = await fs.promises.readFile(attachment.path);
      return { name: attachment.name, data: new Uint8Array(data) };
    },
    onCloudSnapshot: move,
    routineMigration: () => {
      const root = options.localStore()?.root;
      const serviceId = options.baseUrl();
      if (!root || !serviceId || !options.session() || !options.enabled())
        return undefined;
      let journal = migrationJournals.get(root);
      if (!journal) {
        journal = new RoutineMigrationRegistry(root);
        migrationJournals.set(root, journal);
      }
      return {
        journal,
        owner: {
          accountId: createHash("sha256").update(root).digest("hex"),
          serviceId,
          deviceId: deviceLinkId(app.getPath("userData")),
        },
      };
    },
    claims: linkClaims(() => options.localStore()?.root),
    taskPermission: () => options.taskPermission?.(),
    device: () => ({
      id: deviceLinkId(app.getPath("userData")),
      name: deviceName(),
    }),
  });

  return {
    router,
    localEvent: (event: AppEvent) => router.localEvent(event),
    readChatGitHub(input: ChatGitHubRead): Promise<unknown> | undefined {
      return active()
        ?.json(githubRoutes.readRepository, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
        .then((body) =>
          body && typeof body === "object" && "data" in body
            ? (body as { data: unknown }).data
            : body,
        );
    },
    /** The handler main.ts registers for `name`. */
    route(name: string, local: (...args: any[]) => any) {
      if (name === "deleteStoredCodeSessions")
        return async () => {
          const current = active(true);
          if (!current) throw new Error("Sign in to Claudex again.");
          try {
            await current.call(name, []);
            options.push({ type: "resync" });
          } finally {
            if (!options.enabled()) stop();
          }
        };
      const routed = router.route(name, local);
      if (name !== "saveSettings") return routed;
      // Turning sync on or off shows or hides the cloud's conversations.
      return async (...args: any[]) => {
        const before = !!client;
        const value = await routed(...args);
        if (before !== !!active()) options.push({ type: "resync" });
        return value;
      };
    },
    /** Signed out: the stream closes and the cloud's part is forgotten. */
    stop,
  };
}
