import fs from "node:fs";
import path from "node:path";

export const attachmentSelectionChannel = "claudex:trusted-file-selection";

type DraftTransition = {
  scope: string;
  origin: string;
  destination?: string;
  arrived: boolean;
};

export class CoworkDraftSelectionTransition {
  private windows = new WeakMap<object, DraftTransition>();

  selected(window: object, scope: string, origin: string) {
    this.windows.set(window, { scope, origin, arrived: false });
  }

  navigate(
    window: object,
    urlString: string,
    phase: "start" | "in-page" | "document",
  ) {
    const state = this.windows.get(window);
    if (!state || phase === "document") return this.clear(window);
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      return this.clear(window);
    }
    if (
      url.origin !== state.origin ||
      url.search ||
      url.hash ||
      !/^\/cowork\/local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        url.pathname,
      )
    )
      return this.clear(window);
    if (
      state.destination &&
      (state.destination !== url.pathname ||
        phase !== "in-page" ||
        state.arrived)
    )
      return this.clear(window);
    state.destination = url.pathname;
    state.arrived = phase === "in-page";
    return true;
  }

  take(window: object, urlString: string, sessionId: string | undefined) {
    const state = this.windows.get(window);
    this.windows.delete(window);
    if (
      !state?.arrived ||
      !sessionId ||
      state.destination !== `/cowork/${sessionId}` ||
      urlString !== `${state.origin}${state.destination}`
    )
      return undefined;
    return state.scope;
  }

  clear(window: object) {
    this.windows.delete(window);
    return false;
  }
}

function isCoworkHome(url: URL) {
  const query = url.searchParams;
  return (
    url.pathname === "/new" &&
    query.getAll("mode").length === 1 &&
    query.get("mode") === "cowork" &&
    query.getAll("surface").length <= 1 &&
    (!query.has("surface") || query.get("surface") === "cowork")
  );
}

/** Additional gate for the private selection bridge, on top of NativeHost's
 * owned-window check. Only the actual composer main frame may mint. */
export function verifyAttachmentSelectionFrame(
  event: {
    sender: { mainFrame: unknown };
    senderFrame: { url: string } | null;
  },
  origin: string,
) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    throw Error("Untrusted file selection frame.");
  try {
    attachmentSelectionRoute(event.senderFrame.url, origin);
  } catch {
    throw Error("Untrusted file selection origin or surface.");
  }
}
type Identity = { owner: string | undefined; activation: unknown };
type Stamp = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
type Grant = { stamp: Stamp; expires: number; scope: string };
const maxBytes = 64 * 1024 * 1024;
const sameIdentity = (a: Identity, b: Identity) =>
  a.owner === b.owner && a.activation === b.activation;
const sameFile = (a: Stamp, b: Stamp) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

/** Main-process capabilities minted ONLY by the isolated trusted File event
 * bridge. Never expose grant() through NativeHost.on or a renderer API. */
export class AttachmentSelectionGrants {
  private active: Identity;
  private windows = new Map<object, Map<string, Grant>>();
  constructor(
    private readonly current: () => Identity,
    private readonly now = Date.now,
  ) {
    this.active = current();
  }
  private sync() {
    const next = this.current();
    if (!sameIdentity(this.active, next)) {
      this.windows.clear();
      this.active = next;
    }
    if (!next.owner || next.activation === undefined)
      throw Error("No active account for file selection.");
    return next;
  }
  clear() {
    this.windows.clear();
  }
  revokeWindow(window: object) {
    this.windows.delete(window);
  }
  matchingPaths(window: object, files: string[], scope: string) {
    this.sync();
    const grants = this.windows.get(window);
    return [...new Set(files)].filter(
      (file) => grants?.get(file)?.scope === scope,
    );
  }
  grant(window: object, input: unknown, scope = "") {
    const identity = this.sync();
    if (
      !Array.isArray(input) ||
      !input.length ||
      input.length > 12 ||
      input.some(
        (p) =>
          typeof p !== "string" ||
          !path.isAbsolute(p) ||
          p.length > 4096 ||
          path.normalize(p) !== p,
      )
    )
      throw Error("Invalid selected files.");
    if (new Set(input).size !== input.length)
      throw Error("Duplicate selected files.");
    const entries = input.map((file: string) => {
      const stamp = fs.lstatSync(file);
      if (
        !stamp.isFile() ||
        stamp.isSymbolicLink() ||
        fs.realpathSync(file) !== file ||
        !Number.isSafeInteger(stamp.size) ||
        stamp.size < 0
      )
        throw Error("Selected file is not a regular unchanged file.");
      return [file, { stamp, expires: this.now() + 120_000, scope }] as const;
    });
    if (entries.reduce((n, [, g]) => n + g.stamp.size, 0) > maxBytes)
      throw Error("Combined attachments exceed 64 MB.");
    if (!sameIdentity(identity, this.sync()))
      throw Error("The account changed during file selection.");
    // Bounded transient state, never persistent folder trust.
    let grants = this.windows.get(window);
    if (!grants) {
      if (this.windows.size >= 16)
        throw Error("Too many file-selection windows.");
      grants = new Map();
      this.windows.set(window, grants);
    }
    for (const [file, grant] of grants)
      if (grant.expires <= this.now()) grants.delete(file);
    for (const [file, grant] of entries) grants.set(file, grant);
    while (grants.size > 24) grants.delete(grants.keys().next().value!);
  }
  take(
    window: object,
    files: string[],
    budget = maxBytes,
    scope = "",
  ): Array<{ name: string; data: Uint8Array }> {
    const identity = this.sync(),
      grants = this.windows.get(window);
    if (
      !files.length ||
      files.length > 12 ||
      new Set(files).size !== files.length
    )
      throw Error("Invalid selected files.");
    const chosen = files.map((file) => {
      const grant = grants?.get(file);
      if (!grant || grant.expires <= this.now() || grant.scope !== scope)
        throw Error(
          "Select the file again; its selection has expired or belongs to another window.",
        );
      return { file, grant };
    });
    // Revoke atomically before any read or asynchronous storage: no replay, even
    // after a failed policy check. The user can explicitly select it again.
    for (const { file } of chosen) grants!.delete(file);
    if (
      chosen.reduce((n, { grant }) => n + grant.stamp.size, 0) >
      Math.min(maxBytes, budget)
    )
      throw Error("Combined attachments exceed 64 MB.");
    const payload = chosen.map(({ file, grant }) => {
      const before = fs.lstatSync(file);
      if (
        !before.isFile() ||
        !sameFile(before, grant.stamp) ||
        fs.realpathSync(file) !== file
      )
        throw Error("Selected file changed; select it again.");
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = fs.fstatSync(fd);
        if (
          !opened.isFile() ||
          !sameFile(opened, grant.stamp) ||
          fs.lstatSync(file).isSymbolicLink()
        )
          throw Error("Selected file changed; select it again.");
        const data = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < data.length) {
          const read = fs.readSync(
            fd,
            data,
            offset,
            data.length - offset,
            offset,
          );
          if (!read) throw Error("Selected file changed while reading.");
          offset += read;
        }
        if (
          !sameFile(fs.fstatSync(fd), grant.stamp) ||
          !sameFile(fs.lstatSync(file), grant.stamp)
        )
          throw Error("Selected file changed while reading.");
        return { name: path.basename(file), data: new Uint8Array(data) };
      } finally {
        fs.closeSync(fd);
      }
    });
    if (!sameIdentity(identity, this.sync()))
      throw Error("The account changed during file selection.");
    return payload;
  }
}

/** verify is NativeHost's existing top-frame / origin / owned-window gate. */
export function acceptAttachmentSelection<Event>(
  event: Event,
  paths: unknown,
  verify: (event: Event) => object,
  grants: AttachmentSelectionGrants,
  scopeForWindow: (window: object) => string = () => "",
) {
  const window = verify(event);
  grants.grant(window, paths, scopeForWindow(window));
  return true;
}

/** Main-process URL, never a renderer-supplied route. New-session selections
 * can only be consumed on the landing page before the one-shot start transitions. */
export function attachmentSelectionRoute(
  urlString: string,
  origin: string,
  targetSession?: string,
  surface?: "task" | "epitaxy",
) {
  const url = new URL(urlString);
  if (url.origin !== origin) throw Error("Untrusted file selection origin.");
  const route =
    /^\/(task|cowork|epitaxy)\/(new|local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
      url.pathname,
    );
  const actualSurface =
    route?.[1] === "cowork"
      ? "task"
      : route?.[1] ??
        (url.pathname === "/epitaxy"
          ? "epitaxy"
          : isCoworkHome(url)
            ? "task"
            : undefined);
  const actualSession =
    route?.[2] ??
    (url.pathname === "/epitaxy" || isCoworkHome(url) ? "new" : undefined);
  if (
    !actualSession ||
    (route?.[1] === "cowork" && actualSession === "new") ||
    (actualSurface === "epitaxy" &&
      actualSession === "new" &&
      url.pathname !== "/epitaxy") ||
    (surface !== undefined && actualSurface !== surface) ||
    (targetSession !== undefined && actualSession !== targetSession)
  )
    throw Error("Selected files belong to a different session.");
  return url.pathname;
}

/** Observe Electron's main-process navigation events, including SPA changes. */
export function observeAttachmentSelectionNavigation(
  contents: {
    on(event: string, listener: (...args: any[]) => void): unknown;
    removeListener(event: string, listener: (...args: any[]) => void): unknown;
  },
  revoke: (url: string, phase: "start" | "in-page" | "document") => void,
) {
  const navigation = (
    _event: unknown,
    url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame) revoke(url, inPlace ? "start" : "document");
  };
  const inPage = (_event: unknown, url: string, mainFrame: boolean) => {
    if (mainFrame) revoke(url, "in-page");
  };
  contents.on("did-start-navigation", navigation);
  contents.on("did-navigate-in-page", inPage);
  return () => {
    contents.removeListener("did-start-navigation", navigation);
    contents.removeListener("did-navigate-in-page", inPage);
  };
}
