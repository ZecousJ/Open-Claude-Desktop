import fs from "node:fs";
import path from "node:path";
import type { NativeHost } from "./host";
import { organizationUuid } from "../api/context";
import { sessionAccountScope } from "./session-account-scope";
import { officialWorkspaceDownload } from "../../../shared/official-workspace-download";
import { wslFolderUnc } from "../../wsl/paths";

const maxDownloadBytes = 64 * 1024 * 1024;
const openable = new Set(
  ".pdf,.txt,.md,.rtf,.docx,.xlsx,.csv,.tsv,.pptx,.pages,.numbers,.key,.png,.jpg,.jpeg,.gif,.bmp,.tif,.tiff,.webp,.svg,.heic,.heif,.ico,.psd,.mp3,.m4a,.wav,.aac,.flac,.aiff,.mp4,.m4v,.mov,.avi,.webm,.zip,.tar,.gz,.tgz,.bz2,.html,.htm,.css,.json,.xml,.yaml,.yml,.epub,.ics,.vcf,.eml,.log".split(
    ",",
  ),
);
// Office/OpenDocument formats for which the original host asks before opening.
const macroCapable = new Set(
  ".doc,.dot,.docm,.dotm,.wbk,.wiz,.xls,.xlt,.xla,.xlm,.xlw,.slk,.xlsm,.xltm,.xlam,.xlsb,.xlk,.ppt,.pot,.pps,.ppa,.pptm,.potm,.ppam,.ppsm,.sldm,.accdb,.accde,.accdr,.accda,.accdt,.mdb,.mde,.mda,.adp,.ade,.mam,.maq,.mar,.mat,.maw,.maf,.mag,.mas,.mav,.mad,.mau,.mdz,.mdt,.mdw,.vsd,.vss,.vst,.vsw,.vsdm,.vssm,.vstm,.pub,.mpp,.mpt,.iqy,.dqy,.oqy,.rqy,.odc,.wll,.one,.onepkg,.odt,.ott,.fodt,.odm,.ods,.ots,.fods,.odp,.otp,.fodp,.odg,.otg,.fodg,.odb,.otm,.oth,.odf,.sxw,.stw,.sxg,.sxc,.stc,.sxi,.sti,.sxd,.std,.oxt,.vsto".split(
    ",",
  ),
);

const localFileErrors: Record<string, string> = {
  outsideSessionFolders: "PATH_NOT_ALLOWED",
  notFound: "NOT_FOUND",
  tooLarge: "FILE_TOO_LARGE",
};

/** Save authorized account downloads and open files in a local Cowork workspace. */
export function registerNativeFileDownloads(
  host: NativeHost,
  options: {
    downloadsDirectory(): string;
    revealFile(filename: string): void;
    openFile(filename: string): Promise<string>;
    confirmOpen(
      filename: string,
      window: NonNullable<NativeHost["window"]>,
    ): Promise<boolean>;
  },
) {
  const saved = new Set<string>();
  const scope = sessionAccountScope(host.ctx, () => saved.clear());
  host.on("CoworkFilePreview.isOpenInDefaultAppEnabled", () =>
    scope.run(() =>
      !host.ctx.readOnly && !!host.ctx.account()?.id &&
      !!host.ctx.localCall && !!host.ctx.localLoadConversation,
    ));
  const codeFile = async (id: unknown, file: unknown) => {
    const ctx = host.ctx;
    if (ctx.readOnly || !ctx.account()?.id || !ctx.localLoadConversation || !ctx.localCall ||
        typeof id !== "string" || !id.startsWith("local_") || typeof file !== "string")
      return;
    const sessionId = id.slice(6);
    const conversation = await scope.guard(() => ctx.localLoadConversation!(sessionId));
    if (!conversation || conversation.mode !== "code" || conversation.environment?.kind === "ssh")
      return;
    const resolved = await scope.guard(() => ctx.localCall!("officialSessionFile", {
      operation: "resolve",
      sessionId,
      path: file,
    })) as { status: string; path?: string };
    if (resolved.status !== "ok" || !resolved.path) return { status: resolved.status };
    const environment = conversation.environment;
    return {
      status: "ok",
      filename: environment?.kind === "wsl"
        ? wslFolderUnc(environment.distro, resolved.path)
        : resolved.path,
    };
  };
  host.on("LocalSessions.getSessionFileOutsideActions", (id: unknown, file: unknown) =>
    scope.run(async () => {
      const result = await codeFile(id, file);
      return { canReveal: Boolean(result?.filename), outsideFolders: result?.status === "outsideSessionFolders" };
    }));
  host.on("LocalSessions.showSessionFileInFolder", (id: unknown, file: unknown) =>
    scope.run(async () => {
      const result = await codeFile(id, file);
      if (!result?.filename) return false;
      scope.sync();
      options.revealFile(result.filename);
      return true;
    }));
  host.on("LocalSessions.openSessionFileInDefaultApp", (id: unknown, file: unknown) =>
    scope.run(async () => {
      const result = await codeFile(id, file);
      if (!result?.filename)
        return { ok: false, error: result?.status === "notFound" ? "File not found" : "Blocked: outside the session folder" };
      const { filename } = result;
      const extension = path.extname(filename).toLowerCase();
      if (typeof file !== "string" || extension !== path.extname(file).toLowerCase() ||
          (!openable.has(extension) && extension !== ".avif" && !macroCapable.has(extension)))
        return { ok: false, error: "Blocked executable file type" };
      if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile())
        return { ok: false, error: "File not found" };
      const window = host.caller ?? host.window;
      if (!window || !await scope.guard(() => options.confirmOpen(filename, window)))
        return { ok: false, error: "Declined" };
      if ((await codeFile(id, file))?.filename !== filename)
        return { ok: false, error: "Path changed during open" };
      const error = await scope.guard(() => options.openFile(filename));
      return error ? { ok: false, error } : { ok: true };
    }));
  const coworkFile = async (
    operation: "readCowork" | "resolveCowork",
    id: string,
    encodedPath: string,
  ) => {
    if (typeof id !== "string" || !/^local_.+/.test(id))
      throw Error(
        "LocalFileAccessError: [INVALID_SESSION] A local Cowork session is required.",
      );
    let filename: string;
    try {
      if (typeof encodedPath !== "string" || !encodedPath)
        throw Error("Missing path");
      filename = decodeURIComponent(encodedPath);
    } catch {
      throw Error(
        "LocalFileAccessError: [INVALID_PATH] The file path is invalid.",
      );
    }
    const result = (await scope.guard(() =>
      host.ctx.localCall!("officialSessionFile", {
        operation,
        sessionId: id.slice(6),
        path: filename,
      }),
    )) as {
      status: string;
      path?: string;
      file?: { content: string; encoding?: "base64"; mimeType?: string };
    };
    if (result.status !== "ok")
      throw Error(
        `LocalFileAccessError: [${localFileErrors[result.status] ?? "FILE_READ_ERROR"}] Workspace file is unavailable.`,
      );
    return result;
  };
  host.on("FileSystem.readLocalFile", (id: string, encodedPath: string) =>
    scope.run(
      async () => (await coworkFile("readCowork", id, encodedPath)).file,
    ),
  );
  host.on(
    "FileSystem.openLocalFile",
    (id: string, encodedPath: string, reveal?: boolean) =>
      scope.run(async () => {
        const { path: filename } = await coworkFile(
          "resolveCowork",
          id,
          encodedPath,
        );
        scope.sync();
        if (!filename)
          throw Error(
            "LocalFileAccessError: [NOT_FOUND] Workspace file is unavailable.",
          );
        if (reveal === true) {
          options.revealFile(filename);
          return;
        }
        if (!openable.has(path.extname(filename).toLowerCase()))
          throw Error(
            "LocalFileAccessError: [BLOCKED_EXTENSION] This file type cannot be opened.",
          );
        if (await scope.guard(() => options.openFile(filename)))
          throw Error(
            "LocalFileAccessError: [FILE_OPEN_ERROR] The file could not be opened.",
          );
      }),
  );
  const download = (name: string, source: string) =>
    scope.run(async () => {
      const owner = host.ctx.account()?.id;
      if (!owner) throw Error("Sign in to download files.");
      if (
        typeof name !== "string" ||
        !name ||
        name.includes("\0") ||
        path.posix.basename(name) !== name ||
        path.win32.basename(name) !== name ||
        name === "." ||
        name === ".."
      )
        throw Error("Invalid download filename.");
      const window = host.caller ?? host.window;
      if (!window || window.isDestroyed())
        throw Error("The download window has closed.");
      const origin = new URL(window.webContents.getURL()).origin;
      const url = new URL(source, origin);
      const organization = organizationUuid(owner);
      const prefix = `/api/organizations/${organization}/files/`;
      const accountFile = !url.search && url.pathname.startsWith(prefix) &&
        /^[a-f0-9-]+\/contents$/i.test(url.pathname.slice(prefix.length));
      const workspaceFile = officialWorkspaceDownload("GET", url.pathname, url.search);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash ||
        (!accountFile && workspaceFile?.organization !== organization)
      )
        throw Error("Only this account's file downloads are supported.");
      const data = await scope.guard(async () => {
        const response = await window.webContents.session.fetch(url.href, {
          redirect: "error",
          credentials: "include",
          signal: AbortSignal.timeout(60_000),
        });
        if (
          !response.ok ||
          !/^attachment\b/i.test(
            response.headers.get("content-disposition") ?? "",
          )
        )
          throw Error("The file could not be downloaded.");
        const reader = response.body?.getReader();
        if (!reader) throw Error("The file could not be read.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxDownloadBytes) {
              await reader.cancel();
              throw Error("The file is too large to download.");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        return Buffer.concat(chunks);
      });
      scope.sync();
      const directory = options.downloadsDirectory();
      fs.mkdirSync(directory, { recursive: true });
      const { name: stem, ext } = path.parse(name);
      for (let index = 0; ; index++) {
        const filename = path.join(
          directory,
          index ? `${stem} (${index})${ext}` : name,
        );
        let fd: number;
        try {
          fd = fs.openSync(filename, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          continue;
        }
        let written = false;
        try {
          fs.writeFileSync(fd, data);
          written = true;
        } finally {
          fs.closeSync(fd);
          if (!written) fs.rmSync(filename, { force: true });
        }
        saved.add(filename);
        return filename;
      }
    });
  host.on("FileSystem.writeFileDownload", download);
  host.on(
    "FileSystem.writeFileDownloadAndOpen",
    (name: string, source: string) =>
      scope.run(async () => {
        const extension =
          typeof name === "string" ? path.extname(name).toLowerCase() : "";
        if (!openable.has(extension) && !macroCapable.has(extension))
          throw Error(
            "This file type cannot be opened automatically. Download it instead.",
          );
        const caller = host.caller ?? host.window;
        const filename = await download(name, source);
        scope.sync();
        if (macroCapable.has(extension)) {
          if (!caller || caller.isDestroyed()) return filename;
          const before = fs.statSync(filename);
          if (
            !(await scope.guard(() =>
              options.confirmOpen(filename, caller),
            ))
          )
            return filename;
          const after = fs.lstatSync(filename);
          if (
            !after.isFile() ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw Error(
              "The downloaded file changed before it could be opened.",
            );
        }
        const failure = await scope.guard(() => options.openFile(filename));
        if (failure) options.revealFile(filename);
        return filename;
      }),
  );
  host.on("FileSystem.showInFolder", (filename: string) =>
    scope.run(() => {
      scope.sync();
      if (!saved.has(filename))
        throw Error("Download this file before revealing it.");
      options.revealFile(filename);
    }),
  );
}
