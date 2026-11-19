import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";
import { codeFilePreviewPath } from "../api/code-file-preview";
import {storeCodeAttachments} from './code-attachments';

/** Official directory/file contracts, backed by the account's authorized disk. */
export function registerCodeFiles(host: NativeHost) {
  const { ctx } = host;
  type DirectoryWatch = {
    sessionId: string;
    paths?: Map<string, string>;
    window: typeof host.window;
  };
  const watches = new Map<string, DirectoryWatch>();
  const scope = sessionAccountScope(ctx, () => watches.clear());
  host.on('FileSystem.savePastedFile',(base64:string,_mime:string,name:string)=>scope.run(async()=>{
    const stored=await storeCodeAttachments((method,...args)=>scope.guard(()=>ctx.localCall!(method,...args)),[],[{name,base64}]);
    return {path:stored[0].path};
  }));
  const call = (
    operation: string,
    sessionId: string | undefined,
    cwd: string | undefined,
    path: string,
    extra = {},
  ) => {
    if (!scope.sync().owner || ctx.readOnly || ctx.isCurrent?.() === false)
      throw Error("The file resource account is no longer active.");
    if (sessionId && !/^local_.+/.test(sessionId))
      throw Error("A local Code session is required.");
    return scope.guard(() =>
      ctx.localCall!("officialSessionFile", {
        operation,
        ...(sessionId ? { sessionId: sessionId.slice(6) } : { cwd }),
        path,
        ...extra,
      }),
    ) as Promise<any>;
  };
  const on = (name: string, fn: (...args: any[]) => unknown) =>
    host.on(`LocalSessions.${name}`, (...args) => scope.run(() => fn(...args)));
  const list = async (
    sessionId: string | undefined,
    cwd: string | undefined,
    path: string,
  ) => {
    const answer = await call("list", sessionId, cwd, path);
    if (answer.status === "notFound") return [];
    if (answer.status !== "ok")
      throw Error(`Folder could not be read: ${answer.status}`);
    return answer.entries;
  };
  const read = (id: string, path: string, options?: unknown) => call("read", id, undefined, path, { options });
  on("listSessionDirectory", (id: string, path: string) =>
    list(id, undefined, path),
  );
  on("listDirectoryAtCwd", (cwd: string, path: string) =>
    list(undefined, cwd, path),
  );
  on("readSessionFileWithStatus", read);
  on("readSessionPanelDocumentWithStatus", (id: string, path: string) =>
    call("downloadDocument", id, undefined, path),
  );
  for (const [method, operation] of [
    ["readSessionImageAsDataUrl", "image"],
    ["readSessionMediaAsDataUrl", "media"],
    ["readSessionPanelMediaAsDataUrl", "panelMedia"],
    ["readSessionPanelDocumentAsDataUrl", "document"],
  ]) {
    on(method, async (id: string, path: string) =>
      (await call(operation, id, undefined, path)).dataUrl ?? null,
    );
  }
  for (const [method, kind] of [
    ["getSessionImageStreamUrl", "image"],
    ["getSessionMediaStreamUrl", "media"],
    ["getSessionPanelMediaStreamUrl", "media"],
  ]) {
    on(method, async (id: string, path: string) => {
      const operation = kind === "image" ? "streamImage" : "streamMedia";
      const result = await call(operation, id, undefined, path);
      if (result.status !== "ok") return null;
      const url = new URL(codeFilePreviewPath, host.origin);
      url.search = new URLSearchParams({ kind, sessionId: id.slice(6), path, v: String(Math.floor(result.mtimeMs)) }).toString();
      return url.href;
    });
  }
  on(
    "readSessionFile",
    async (id: string, path: string, options?: unknown) => (await read(id, path, options)).file ?? null,
  );
  on(
    "readFileAtCwd",
    async (cwd: string, path: string) =>
      (await call("read", undefined, cwd, path)).file ?? null,
  );
  on(
    "resolveSessionFile",
    async (id: string, path: string) =>
      (await call("resolve", id, undefined, path)).path ?? null,
  );
  on("getSessionFilePlacement", async (id: string, path: string) => {
    const result = await call("resolve", id, undefined, path);
    return result.status === "outsideSessionFolders"
      ? "outside"
      : "sessionFolder";
  });
  const mutate = async (operation: "write" | "create", id: string, path: string, extra = {}) => {
    const result = await call(operation, id, undefined, path, extra);
    if (result?.status === "ok" || operation === "write" && result?.status === "conflict")
      host.emit("LocalSessions", "onEvent", { type: "git_state_changed", sessionId: id });
    return result;
  };
  on(
    "writeSessionFile",
    (id: string, path: string, contents: string, expectedHash?: string) =>
      mutate("write", id, path, { contents, expectedHash }),
  );
  on("createSessionFile", (id: string, path: string) =>
    mutate("create", id, path),
  );
  host.on("CoworkFilePreview.isEpitaxyPreviewEnabled", () => false);
  // The official sandbox fallback renders documents; there is no native overlay.
  host.on("CoworkFilePreview.isBuiltInViewerAvailable", () => false);
  on(
    "watchSessionDirectories",
    async (request: {
      sessionId: string;
      watchId: string;
      dirPaths: string[];
    }) => {
      if (
        !request ||
        typeof request.watchId !== "string" ||
        request.watchId.length > 200 ||
        !Array.isArray(request.dirPaths) ||
        request.dirPaths.length > 64 ||
        request.dirPaths.some((p) => typeof p !== "string")
      )
        throw Error("Invalid directory watch request.");
      const window = host.caller ?? host.window;
      const key = `${window?.id ?? 0}:${request.watchId}`;
      if (!request.dirPaths.length) {
        watches.delete(key);
        return;
      }
      if (!watches.has(key) && watches.size >= 100)
        throw Error("Too many directory watches.");
      const watch: DirectoryWatch = { sessionId: request.sessionId, window };
      watches.set(key, watch);
      const paths = new Map<string, string>();
      try {
        for (const path of request.dirPaths) {
          if (watches.get(key) !== watch) return;
          paths.set(path, JSON.stringify(await list(watch.sessionId, undefined, path)));
        }
        if (watches.get(key) === watch) watch.paths = paths;
      } catch (error) {
        if (watches.get(key) === watch) watches.delete(key);
        throw error;
      }
    },
  );
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      scope.sync();
      for (const [key, watch] of [...watches]) {
        if (watch.window?.isDestroyed()) {
          watches.delete(key);
          continue;
        }
        if (!watch.paths) continue;
        for (const [path, old] of watch.paths) {
          let current: string;
          try {
            current = JSON.stringify(
              await list(watch.sessionId, undefined, path),
            );
          } catch {
            current = "unavailable";
          }
          if (watches.get(key) !== watch) break;
          if (current !== old) {
            watch.paths.set(path, current);
            if (watch.window)
              host.emitTo(
                watch.window,
                "LocalSessions",
                "sessionDirectoryChanged",
                watch.sessionId,
                path,
              );
            else
              host.emit(
                "LocalSessions",
                "sessionDirectoryChanged",
                watch.sessionId,
                path,
              );
          }
        }
      }
    } finally {
      polling = false;
    }
  }, 1500);
  timer.unref();
  return () => {
    clearInterval(timer);
    watches.clear();
  };
}
