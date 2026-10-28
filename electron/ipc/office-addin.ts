import fs from "node:fs/promises";
import path from "node:path";
import { app, dialog, shell } from "electron";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { OfficeAddinBridge } from "../connectors/office-addin";
import { officeInstallation } from "../connectors/office-addin-installation";
import { nativeTranslator } from "../app/native-i18n";
import { preference } from "../../shared/settings-extras";
import { startOfficeMcp } from "../connectors/office-mcp";

const handoff = z.object({
  sessionId: z.string().min(1).max(500),
  filePath: z.string().min(1).max(4000),
  title: z.string().max(1000),
  messages: z
    .array(
      z.object({ role: z.string().max(30), text: z.string().max(100_000) }),
    )
    .max(100),
  strippedToolCalls: z.number().int().nonnegative(),
  omittedByRenderer: z.number().int().nonnegative(),
});

export function registerOfficeAddinHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  let pending: Promise<OfficeAddinBridge> | undefined;
  let epoch = 0;
  let stopMcp: (() => Promise<void>) | undefined;
  const getBridge = () => {
    const generation = epoch;
    if (ctx.policy().desktopExtensionsEnabled === false)
      throw new Error(
        "Extensions are disabled on this device. Please contact your IT administrator to enable extensions.",
      );
    return (pending ??= (async () => {
      const installation = await officeInstallation(ctx.store.root);
      const bridge = new OfficeAddinBridge(
        (files) => ctx.push({ type: "office-addin-files", files }),
        installation,
      );
      try {
        await bridge.start();
        if (generation !== epoch) throw new Error("Report cancelled.");
        await installation.save(bridge.configuration());
        const stop = await startOfficeMcp(ctx, bridge);
        if (generation !== epoch) {
          await stop();
          throw new Error("Report cancelled.");
        }
        stopMcp = stop;
        return bridge;
      } catch (error) {
        bridge.dispose();
        throw error;
      }
    })().catch((error) => {
      if (generation === epoch) pending = undefined;
      throw error;
    }));
  };
  ctx.onAccountDeactivating(() => {
    epoch++;
    void pending?.then(
      (bridge) => bridge.dispose(),
      () => {},
    );
    pending = undefined;
    const stop = stopMcp;
    stopMcp = undefined;
    return stop?.();
  });
  ctx.onAccountActivated(() => {
    const generation = epoch;
    void fs
      .stat(path.join(ctx.store.root, "office-addin", "bridge.json"))
      .then(() => {
        if (generation === epoch) return getBridge();
      })
      .catch(() => {});
  });
  ctx.onEvent((event) => {
    if (
      event.type === "policy" &&
      ctx.policy().desktopExtensionsEnabled === false
    ) {
      epoch++;
      void pending?.then(
        (bridge) => bridge.dispose(),
        () => {},
      );
      pending = undefined;
      const stop = stopMcp;
      stopMcp = undefined;
      void stop?.();
    }
  });
  handle("officeConnectedFiles", async () =>
    pending ? (await pending).connectedFiles() : [],
  );
  handle("officeSelectFile", async (raw: unknown) =>
    (await getBridge()).select(z.string().uuid().parse(raw)),
  );
  handle("officeFocusFile", async (raw: unknown) =>
    (await getBridge()).focus(z.string().uuid().parse(raw)),
  );
  handle("officeUpdateActiveConversationSummary", async (raw: unknown) => {
    const summary = z
      .object({
        summary: z.string().max(100_000),
        taskTitle: z.string().max(1000).optional(),
        conversationId: z.string().max(500).optional(),
        isStreaming: z.boolean().optional(),
      })
      .nullable()
      .parse(raw);
    if (pending) (await pending).updateSummary(summary);
  });
  handle("officeQueuePorterHandoff", async (raw: unknown) => {
    const input = handoff.parse(raw);
    const conversation = ctx.store.conversations.find(
      (conversation) => conversation.id === input.sessionId,
    );
    if (!conversation) throw new Error("Conversation not found.");
    if (
      ![...ctx.selectedAttachments.values()].some(
        (attachment) => attachment.path === input.filePath,
      )
    )
      ctx.allowedFolder(path.dirname(input.filePath));
    if (!/\.(?:xlsx|docx|pptx)$/i.test(input.filePath))
      throw new Error("Choose an Office file.");
    const bridge = await getBridge();
    const result = bridge.queue(input);
    if (result.queued) {
      const error = await shell.openPath(input.filePath);
      if (error) {
        if (result.handoffId) bridge.cancel(result.handoffId);
        throw new Error(error);
      }
    }
    return result;
  });
  handle("officeCancelPorterHandoff", async (raw: unknown) =>
    (await getBridge()).cancel(z.string().uuid().parse(raw)),
  );
  handle("officeInstallAddin", async () => {
    const bridge = await getBridge();
    const translate = await nativeTranslator(
      preference(ctx.store.settings, "locale"),
    );
    const options = {
      defaultPath: path.join(app.getPath("downloads"), "claudex-office.xml"),
      filters: [{ name: translate("XML"), extensions: ["xml"] }],
    };
    const result = ctx.window
      ? await dialog.showSaveDialog(ctx.window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { manifestPath: "" };
    await fs.writeFile(result.filePath, bridge.manifest(), { mode: 0o600 });
    await fs.copyFile(
      (await officeInstallation(ctx.store.root)).certPath,
      path.join(path.dirname(result.filePath), "claudex-office.crt"),
    );
    shell.showItemInFolder(result.filePath);
    return { manifestPath: result.filePath };
  });
}
