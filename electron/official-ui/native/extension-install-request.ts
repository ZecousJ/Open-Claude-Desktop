import { pickedExtensionFolder } from "../../connectors/extension-picked-folder";
import { captureExtensionInstallLease } from "../../connectors/extension-install-lease";
import { readPickedExtensionArchive } from "../../connectors/extension-picked-archive";
import { unpackExtensionArchive } from "../../connectors/desktop-extension";
import { officialExtensionId } from "../../connectors/extension-identity";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { NativeHost } from "./host";
export function createExtensionInstaller(
  host: Pick<NativeHost, "ctx" | "caller" | "emit" | "emitTo" | "takeExtensionDrop">,
  chooseArchive?: (
    window: NonNullable<NativeHost["caller"]>,
  ) => Promise<string | undefined>,
  takeFolder?: (window: NonNullable<NativeHost["caller"]>, folder: unknown) => string,
) {
  const { ctx } = host;
  const pendingInstalls = new WeakSet<object>();
  const previews = new WeakMap<
    object,
    {
      identity: object;
      id: string;
      path: string;
      file: { name: string; data: Buffer };
    }
  >();
  const install = async (
    kind: "archive" | "folder",
    suppliedPath?: unknown,
  ) => {
    const caller = host.caller;
    if (!caller || !ctx.localCall || !ctx.withCallerWindow)
      throw Error("Open extension settings again before installing.");
    const identity = ctx.sessionIdentity?.();
    if (!identity || typeof identity !== "object")
      throw Error("Sign in before installing an extension.");
    if (pendingInstalls.has(caller))
      throw Error("An extension installation is already open in this window.");
    const lease = captureExtensionInstallLease(() => ({
      accountId: ctx.account()?.id,
      store: ctx.sessionIdentity?.() as object,
      generation: 0,
      window: caller,
    }));
    pendingInstalls.add(caller);
    try {
      const call = (method: string, ...args: unknown[]) =>
        lease.wait(
          Promise.resolve(
            ctx.withCallerWindow!(caller, () => ctx.localCall!(method, ...args)),
          ),
        );
      const result =
        suppliedPath === undefined
          ? await call("installExtension")
          : kind === "folder"
            ? await call("installUnpackedExtension", pickedExtensionFolder(takeFolder!(caller, suppliedPath)))
            : await call("installExtension", host.takeExtensionDrop(caller, suppliedPath));
      lease.assertCurrent();
      if (result !== null && (typeof result !== "string" || !result))
        throw Error("The extension installation result was not confirmed.");
      if (result !== null) host.emit("Extensions", "extensionsChanged");
      if (typeof result === "string") {
        const settings = ctx.settings() as { mcpServers?: Record<string, { claudex_extension_id?: unknown }> };
        const official = settings.mcpServers?.[result]?.claudex_extension_id;
        return typeof official === "string" ? official : result;
      }
      return null;
    } finally {
      lease.dispose();
      pendingInstalls.delete(caller);
    }
  };
  const preview = async (droppedPath?: unknown, sourceWindow = host.caller) => {
    const caller = sourceWindow;
    const identity = ctx.sessionIdentity?.();
    if (!caller || !identity || typeof identity !== "object" || !chooseArchive)
      throw Error("Open extension settings again before installing.");
    if (pendingInstalls.has(caller))
      throw Error("An extension installation is already open in this window.");
    const lease = captureExtensionInstallLease(() => ({
      accountId: ctx.account()?.id,
      store: ctx.sessionIdentity?.() as object,
      generation: 0,
      window: caller,
    }));
    pendingInstalls.add(caller);
    try {
      const selected = droppedPath === undefined ? await lease.wait(chooseArchive(caller)) : droppedPath;
      if (!selected || typeof selected !== "string") return null;
      const file = droppedPath === undefined ? readPickedExtensionArchive(selected) : host.takeExtensionDrop(caller, selected);
      const directory = unpackExtensionArchive(file.data, os.tmpdir());
      try {
        const manifest = z
          .object({ name: z.string().min(1), version: z.string().min(1), author: z.object({ name: z.string().optional() }).passthrough().optional() })
          .passthrough()
          .parse(
            JSON.parse(
              fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
            ),
          );
        if (
          typeof manifest.icon === "string" &&
          !/^(?:https?:|data:)/i.test(manifest.icon) &&
          !path.isAbsolute(manifest.icon)
        ) {
          const icon = path.resolve(directory, manifest.icon);
          const mime = (
            {
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".svg": "image/svg+xml",
              ".webp": "image/webp",
            } as Record<string, string>
          )[path.extname(icon).toLowerCase()];
          if (icon.startsWith(directory + path.sep) && mime) {
            try {
              const stat = fs.lstatSync(icon);
              if (
                stat.isFile() &&
                !stat.isSymbolicLink() &&
                stat.size <= 256 * 1024
              )
                manifest.icon = `data:${mime};base64,${fs.readFileSync(icon).toString("base64")}`;
              else delete manifest.icon;
            } catch {
              delete manifest.icon;
            }
          } else delete manifest.icon;
        } else if (
          typeof manifest.icon === "string" &&
          path.isAbsolute(manifest.icon)
        )
          delete manifest.icon;
        lease.assertCurrent();
        const id = officialExtensionId(manifest, selected.toLowerCase().endsWith(".dxt") ? "local.dxt" : "local.mcpb");
        previews.set(caller, {
          identity,
          id,
          path: selected,
          file,
        });
        host.emitTo(
          caller,
          "Extensions",
          "previewExtensionInstallation",
          manifest,
          selected,
          id,
          null,
        );
        return null;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } finally {
      lease.dispose();
      pendingInstalls.delete(caller);
    }
  };
  const installPreview = async (id: unknown, selected: unknown) => {
    const caller = host.caller;
    const saved = caller && previews.get(caller);
    if (
      !caller ||
      !saved ||
      saved.id !== id ||
      saved.path !== selected ||
      saved.identity !== ctx.sessionIdentity?.() ||
      ctx.isCurrent?.() === false ||
      !ctx.localCall ||
      !ctx.withCallerWindow
    )
      throw Error("Choose the extension again in the system picker.");
    if (pendingInstalls.has(caller))
      throw Error("An extension installation is already open in this window.");
    const lease = captureExtensionInstallLease(() => ({
      accountId: ctx.account()?.id,
      store: ctx.sessionIdentity?.() as object,
      generation: 0,
      window: caller,
    }));
    pendingInstalls.add(caller);
    try {
      const result = await lease.wait(
        Promise.resolve(
          ctx.withCallerWindow(caller, () =>
            ctx.localCall!("installExtension", saved.file),
          ),
        ),
      );
      if (result !== null && (typeof result !== "string" || !result))
        throw Error("The extension installation result was not confirmed.");
      if (result !== null) {
        previews.delete(caller);
      }
      return result === null ? null : saved.id;
    } finally {
      try {
        if (lease.current()) host.emit("Extensions", "extensionsChanged");
      } finally {
        lease.dispose();
        pendingInstalls.delete(caller);
      }
    }
  };
  return Object.assign(install, { preview, installPreview });
}
