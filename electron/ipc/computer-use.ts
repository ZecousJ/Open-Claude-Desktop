import path from "node:path";
import fs from "node:fs";
import { PreviewStream } from "../artifacts/preview-stream";
import {
  requestPreviewFramePort,
  sendPreviewFrame,
} from "../artifacts/preview-frame-port";
import { execFile } from "node:child_process";
import { app, clipboard, shell } from "electron";
import { z } from "zod";
import {
  computerUseInstructions,
  computerUseServerName,
  controlEnv,
  isScreenshotId,
  type ComputerUsePermissions,
  type ComputerUseState,
} from "../../shared/computer-use";
import { unavailableComputerUse } from "../../shared/computer-use-api";
import { computerUsePolicyOf } from "../../shared/client-policy";
import type { AppContext, IpcHandle } from "../app/app-context";
import {
  ComputerUseBroker,
  type BrokerConversation,
  type KnownApp,
} from "../computer-use/broker";
import {
  canHideApps,
  hideOtherApps,
  unhideApps,
} from "../computer-use/app-visibility";
import { ControlServer } from "../computer-use/control-server";
import { DriverHost, readDriverManifest } from "../computer-use/driver-host";
import { OpenComputerUseDriver } from "../computer-use/drivers/open-computer-use";
import { electronTranscoder } from "../computer-use/image-transcoder";
import { FullControlIndicator } from "../computer-use/indicator";
import { TeachOverlay } from "../computer-use/teach";
import { nativeTranslator } from "../app/native-i18n";
import { preference } from "../../shared/settings-extras";
import {
  InstalledApps,
  type InstalledApp,
} from "../computer-use/installed-apps";
import { PermissionMonitor } from "../computer-use/permissions";
import { ScreenshotStore } from "../computer-use/screenshots";
import type { ComputerUseService } from "../computer-use/service";
import {
  ComputerUseSettingsStore,
  settingsPatchSchema,
} from "../computer-use/settings-store";
import { registerComputerUseExtension } from "../connectors/computer-use-extension";

/** The installed driver: packaged under resources, in development under build/. */
function driverDir() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "computer-use")
    : path.join(app.getAppPath(), "build", "computer-use");
  const arch = path.join(base, process.arch);
  return fs.existsSync(arch) ? arch : base;
}

const answerSchema = z.union([
  z.literal("deny"),
  z
    .object({
      allow: z.array(z.string().min(1).max(300)).max(20),
      deny: z.array(z.string().min(1).max(300)).max(20),
    })
    .strict(),
]);

/** One signed-in account's computer use. */
class AccountComputerUse {
  readonly settings: ComputerUseSettingsStore;
  readonly screenshots: ScreenshotStore;
  readonly broker: ComputerUseBroker;
  readonly unattended = new Set<string>();
  private hidden: string[] = [];

  constructor(
    private ctx: AppContext,
    private shared: SharedParts,
  ) {
    const profile = ctx.store.root;
    const teach = new TeachOverlay(
      () => nativeTranslator(preference(ctx.store.settings, "locale")),
      () => void this.broker.stop(),
    );
    this.settings = new ComputerUseSettingsStore(profile);
    this.screenshots = new ScreenshotStore(
      path.join(profile, "computer-use", "screenshots"),
      electronTranscoder,
    );
    const platform =
      process.platform === "darwin" || process.platform === "win32"
        ? process.platform
        : "linux";
    this.broker = new ComputerUseBroker({
      teach,
      platform,
      policy: () => computerUsePolicyOf(ctx.policy()),
      settings: () => this.settings.get(),
      driverInstalled: () => Boolean(shared.driver),
      permissionsReady: () => shared.permissions.ready(),
      conversation: (id) => this.conversation(id),
      driver: shared.driver ?? missingDriver,
      screenshots: this.screenshots,
      installedApps: () => shared.installed.list(),
      icon: (known) =>
        known.path
          ? shared.installed.icon(known as InstalledApp)
          : Promise.resolve(undefined),
      openApp: (known, background) => openApp(known, background),
      emit: {
        request: (request) => ctx.push({ type: "computer-use", request }),
        resolved: (id) => ctx.push({ type: "computer-use", resolved: id }),
        activity: (activity) => ctx.push({ type: "computer-use", activity }),
      },
      fullControl: {
        begin: async (_conversationId, keep, appName) => {
          shared.indicator.show(appName);
          if (canHideApps)
            this.hidden = await hideOtherApps(keep.map((known) => known.id));
        },
        update: (appName) => shared.indicator.show(appName),
        end: async (unhide) => {
          shared.indicator.hide();
          const hidden = this.hidden;
          this.hidden = [];
          if (unhide) await unhideApps(hidden);
        },
      },
      clipboard: {
        read: () => clipboard.readText(),
        write: (text) => clipboard.writeText(text),
      },
    });
    // Screenshots of conversations deleted since the last run.
    try {
      this.screenshots.prune(
        new Set(ctx.store.conversations.map((conversation) => conversation.id)),
      );
    } catch {}
  }

  private conversation(id: string): BrokerConversation | undefined {
    const conversation = this.ctx.store.conversations.find((c) => c.id === id);
    if (!conversation) return undefined;
    const last = conversation.turns.at(-1);
    return {
      mode: conversation.mode,
      incognito: Boolean(conversation.incognito),
      running: last?.status === "inProgress",
      turnId: last?.id,
      remote: conversation.environment?.kind === "ssh",
      unattended: this.unattended.has(id),
    };
  }

  state(): ComputerUseState {
    const policy = computerUsePolicyOf(this.ctx.policy());
    const reason = this.broker.unavailableReason();
    return {
      available: !reason,
      ...(reason ? { reason } : {}),
      settings: this.settings.get(),
      allowFullControl: policy.allowFullControl,
      adminDeniedApps: [...policy.deniedApps],
      canHideApps,
      ...(process.platform === "darwin"
        ? { permissions: this.shared.permissions.current() }
        : {}),
      activity: this.broker.currentActivity(),
      requests: this.broker.requests(),
    };
  }
}

const missingDriver = {
  listApps: async () => {
    throw new Error("The computer use driver isn't installed.");
  },
  call: async () => {
    throw new Error("The computer use driver isn't installed.");
  },
  stop: async () => {},
};

function openApp(known: KnownApp, background: boolean): Promise<void> {
  if (process.platform === "darwin")
    return new Promise((resolve, reject) =>
      execFile(
        "/usr/bin/open",
        [...(background ? ["-g"] : []), "-b", known.id],
        { timeout: 15_000 },
        (error) =>
          error
            ? reject(new Error(`${known.name} couldn't be opened.`))
            : resolve(),
      ),
    );
  if (process.platform === "win32" && known.path)
    return shell.openPath(known.path).then((message) => {
      if (message) throw new Error(`${known.name} couldn't be opened.`);
    });
  return Promise.reject(
    new Error(`Claudex can't open ${known.name}. Ask the person to open it.`),
  );
}

/** Parts that live as long as the app, whoever is signed in. */
interface SharedParts {
  driver?: OpenComputerUseDriver;
  permissions: PermissionMonitor;
  installed: InstalledApps;
  indicator: FullControlIndicator;
  control: ControlServer;
}

/**
 * Computer use (R10, shared/computer-use-api.ts): the broker, its driver,
 * the control channel for the MCP adapter and the Settings calls. The
 * engine offers the tools through `ctx.services.computerUse` (R10-E).
 */
export function registerComputerUseHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  let account: AccountComputerUse | undefined;
  const manifest =
    process.platform === "darwin" || process.platform === "win32"
      ? readDriverManifest(driverDir())
      : undefined;
  const shared: SharedParts = {
    driver: manifest
      ? new OpenComputerUseDriver(new DriverHost({ manifest }))
      : undefined,
    permissions: new PermissionMonitor(),
    installed: new InstalledApps(),
    indicator: new FullControlIndicator(
      () => void account?.broker.stop(),
      // An Esc the driver itself pressed for the model isn't the person's Stop.
      () => {
        if (account && !account.broker.pressingEscape())
          void account.broker.stop();
      },
      () => nativeTranslator(preference(ctx.store.settings, "locale")),
    ),
    control: new ControlServer({
      runDir: ctx.dataRoot,
      handle: async (conversationId, call) => {
        if (!account)
          return {
            content: [{ type: "text", text: "Sign in to use computer use." }],
            isError: true,
          };
        return account.broker.handle(conversationId, call);
      },
    }),
  };
  let listening: Promise<void> | undefined;
  const listen = () => {
    if (!shared.driver) return;
    listening ??= shared.control.start().catch((error) => {
      listening = undefined;
      console.error("Computer use channel failed:", error?.message ?? error);
    });
  };

  const changed = () => ctx.push({ type: "computer-use", changed: true });
  const previews = new Map<string, PreviewStream<string | null>>();
  ctx.onAccountDeactivating(() => {
    for (const stream of previews.values()) stream.dispose();
    previews.clear();
  });
  handle("previewRequestFramePort", async () => {
    const window = ctx.callerWindow();
    if (window) await requestPreviewFramePort(ctx, window);
  });
  handle(
    "computerUseSetSubscribed",
    async (rawId: unknown, rawOn: unknown, rawFps: unknown) => {
      const id = z.string().min(1).max(200).parse(rawId);
      const on = z.boolean().parse(rawOn);
      const fps = z.number().finite().min(1).max(30).default(4).parse(rawFps);
      const window = ctx.callerWindow();
      if (!window) return;
      const key = `${window.id}:${id}`;
      let stream = previews.get(key);
      if (!on) {
        stream?.dispose();
        previews.delete(key);
        return;
      }
      const active = current();
      if (!stream) {
        const close = () => {
          previews.get(key)?.dispose();
          previews.delete(key);
        };
        stream = new PreviewStream(
          () =>
            account === active
              ? active.broker.preview(id)
              : Promise.resolve(null),
          (dataUrl) => {
            if (!window.isDestroyed())
              sendPreviewFrame(ctx, window, {
                type: "computer-use",
                frame: { conversationId: id, dataUrl },
              });
          },
          () => {
            window.removeListener("closed", close);
            window.webContents.removeListener("did-start-loading", close);
            window.webContents.removeListener("render-process-gone", close);
          },
        );
        previews.set(key, stream);
        window.once("closed", close);
        window.webContents.once("did-start-loading", close);
        window.webContents.once("render-process-gone", close);
      }
      stream.setFps(fps);
      stream.setSubscribed(true);
      await requestPreviewFramePort(ctx, window);
    },
  );

  const service: ComputerUseService = {
    instructions: computerUseInstructions,
    enabledFor: (id) => Boolean(account?.broker.enabledFor(id)),
    mcpServer: (id) => {
      if (!account?.broker.enabledFor(id) || !shared.control.address)
        return undefined;
      return {
        name: computerUseServerName,
        command: process.execPath,
        args: [
          path.join(
            path.dirname(ctx.providerServiceScript),
            "computer-use-mcp.cjs",
          ),
        ],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          [controlEnv.socket]: shared.control.address,
          [controlEnv.token]: shared.control.tokenFor(id),
          [controlEnv.conversation]: id,
        },
        startupTimeoutSec: 10,
        toolTimeoutSec: 660,
      };
    },
    markUnattended: (id, unattended) => {
      if (!account) return;
      if (unattended) account.unattended.add(id);
      else account.unattended.delete(id);
    },
    screenshotBytes: () => account?.screenshots.bytes() ?? 0,
    deleteConversation: async (id) => {
      if (!account) return;
      await account.broker.forget(id);
      account.screenshots.deleteConversation(id);
    },
  };

  ctx.onAccountActivated(() => {
    account = new AccountComputerUse(ctx, shared);
    ctx.services.computerUse = service;
    listen();
    changed();
  });
  // R10-E: the engine offers the adapter per thread.
  registerComputerUseExtension(ctx);
  ctx.onAccountDeactivating(async () => {
    const leaving = account;
    account = undefined;
    ctx.services.computerUse = undefined;
    if (leaving) {
      leaving.screenshots.clearMemory();
      await leaving.broker.dispose();
    }
  });
  ctx.onEvent((event) => {
    if (!account) return;
    if (event.type === "conversation") {
      const last = event.conversation.turns.at(-1);
      if (last?.status !== "inProgress")
        void account.broker.turnEnded(event.conversation.id);
    } else if (event.type === "policy") {
      void account.broker.settingsChanged();
      changed();
    }
  });
  let lastPermissions: ComputerUsePermissions | undefined;
  ctx.onWindowFocus(() => {
    if (process.platform !== "darwin" || !account) return;
    const permissions = shared.permissions.current();
    if (
      lastPermissions &&
      (lastPermissions.accessibility !== permissions.accessibility ||
        lastPermissions.screen !== permissions.screen)
    )
      ctx.push({ type: "computer-use", permissions });
    lastPermissions = permissions;
  });
  app.once("will-quit", () => {
    shared.indicator.hide();
    void account?.broker.dispose();
    void shared.control.close();
  });

  const current = () => {
    if (!account) throw new Error("Sign in to use computer use.");
    return account;
  };

  handle("computerUseState", async () =>
    account ? account.state() : structuredClone(unavailableComputerUse),
  );
  handle("saveComputerUseSettings", async (patch: unknown) => {
    const active = current();
    const reason = active.broker.unavailableReason();
    if (reason === "policy")
      throw new Error("Computer use is turned off by your administrator.");
    if (reason)
      throw new Error("Computer use isn't available on this computer.");
    const parsed = settingsPatchSchema.parse(patch);
    if (
      parsed.mode === "fullControl" &&
      !computerUsePolicyOf(ctx.policy()).allowFullControl
    )
      throw new Error("Your administrator doesn't allow full control.");
    active.settings.save(parsed);
    await active.broker.settingsChanged();
    changed();
    return active.state();
  });
  handle("computerUseInstalledApps", async () => {
    if (!account || !shared.driver) return [];
    return shared.installed.withIcons();
  });
  handle("requestComputerUsePermission", async (kind: unknown) => {
    current();
    const parsed = z.enum(["accessibility", "screen"]).parse(kind);
    const permissions = await shared.permissions.request(parsed);
    ctx.push({ type: "computer-use", permissions });
    return permissions;
  });
  handle("openComputerUsePermissionSettings", async (kind: unknown) => {
    current();
    await shared.permissions.open(
      z.enum(["accessibility", "screen"]).parse(kind),
    );
  });
  handle("relaunchForPermissions", async () => {
    current();
    ctx.noActive();
    app.relaunch();
    app.quit();
  });
  handle("answerComputerUseAccess", async (id: unknown, decision: unknown) => {
    const active = current();
    active.broker.answer(
      z.string().uuid().parse(id),
      answerSchema.parse(decision),
    );
  });
  handle("stopComputerUse", async (conversationId: unknown) => {
    if (!account) return;
    await account.broker.stop(z.string().min(1).max(200).parse(conversationId));
  });
  handle("computerUseScreenshot", async (id: unknown, size: unknown) => {
    if (!account) return null;
    const screenshotId = z.string().parse(id);
    if (!isScreenshotId(screenshotId)) return null;
    return account.screenshots.read(
      screenshotId,
      z.enum(["thumb", "full"]).parse(size),
    );
  });
  handle("computerUsePreview", async (conversationId: unknown) => {
    const id = z.string().min(1).max(200).parse(conversationId);
    return account?.broker.preview(id) ?? null;
  });
}
