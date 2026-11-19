import { app, shell } from "electron";
import { randomBytes } from "node:crypto";
import { Listeners, type AppContext } from "../app/app-context";
import type { EngineExtension } from "../engine/engine-extensions";
import type { Conversation } from "../../shared/types";
import { browserPolicyOf } from "../../shared/client-policy";
import { browserToolsOn } from "./browser-tools-registration";
import { ChromeExtensionBridge } from "./chrome-extension-bridge";
import {
  chromeExtensionAvailable,
  chromeExtensionBundlePath,
  installChromeExtensionHost,
  publishChromeExtensionEndpoint,
} from "./chrome-extension-install";
import {
  chromeMcpName,
  chromeMcpTokenEnv,
  chromeToolInstructions,
  ChromeExtensionTools,
} from "./chrome-extension-tools";
import { BrowserMcpServer } from "./mcp-server";

type ChromeExtensionStatus = {
  enabled: boolean;
  bundlePath: string;
  connected: boolean;
};
interface ChromeExtensionControls {
  status(): ChromeExtensionStatus;
  configure(enabled: boolean): Promise<ChromeExtensionStatus>;
  revealBundle(): Promise<void>;
  onStatusChanged(listener: () => void): () => void;
}

type Activation = {
  identity: unknown;
  store: AppContext["store"];
  engine: AppContext["engine"];
  generation: number;
  starting: boolean;
  connection?: {
    bridge: ChromeExtensionBridge;
    close(): Promise<void>;
  };
};

const controls = new WeakMap<AppContext, ChromeExtensionControls>();
export function chromeExtensionControls(ctx: AppContext) {
  return chromeExtensionAvailable() ? controls.get(ctx) : undefined;
}

function localInteractive(conversation: Conversation) {
  return (
    !conversation.incognito &&
    !conversation.cloudHosted &&
    !conversation.cloudEnvironmentId &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    !conversation.deviceChatOrigin &&
    (!conversation.environment || conversation.environment.kind === "local")
  );
}

export function registerChromeExtensionTools(ctx: AppContext) {
  const statusListeners = new Listeners<void>();
  let owner: Activation | undefined;
  const current = (activation: Activation) =>
    owner === activation &&
    !ctx.accountRetiring &&
    ctx.accountActivationIdentity === activation.identity &&
    ctx.store === activation.store;

  const status = (): ChromeExtensionStatus => ({
    enabled: owner?.store.settings.chromeExtensionEnabled === true,
    bundlePath: chromeExtensionBundlePath(),
    connected: owner?.connection?.bridge.page() !== undefined,
  });
  const setEnabled = (activation: Activation, enabled: boolean) => {
    if (!current(activation)) throw Error("The signed-in account changed.");
    const before = activation.store.settings;
    if (before.chromeExtensionEnabled === enabled) return;
    activation.store.settings = { ...before, chromeExtensionEnabled: enabled };
    try {
      activation.store.flush();
    } catch (error) {
      activation.store.settings = before;
      throw error;
    }
    ctx.settingsChanged();
  };

  const stop = (activation: Activation) => {
    activation.generation++;
    activation.starting = false;
    const previous = activation.connection;
    activation.connection = undefined;
    return previous?.close();
  };

  const start = async (activation: Activation, install: boolean) => {
    if (activation.connection) return;
    if (activation.starting)
      throw Error("Chrome extension setup is already running.");
    const generation = ++activation.generation;
    activation.starting = true;
    const isCurrent = () =>
      current(activation) && activation.generation === generation;
    const bridge = new ChromeExtensionBridge(() => {
      if (isCurrent()) statusListeners.emit();
    });
    const token = randomBytes(32).toString("base64url");
    const conversation = (id: string) =>
      isCurrent()
        ? activation.store.conversations.find((value) => value.id === id)
        : undefined;
    const offered = (id: string) => {
      const row = conversation(id);
      return (
        !!row &&
        activation.store.settings.chromeExtensionEnabled === true &&
        localInteractive(row) &&
        browserToolsOn(activation.store.settings, ctx.policy(), row.mode) &&
        ctx.engineFor(id) === activation.engine &&
        activation.engine.environment.kind === "local" &&
        !ctx.scheduler?.isUnattended(id)
      );
    };
    const server = new BrowserMcpServer({
      token,
      serverName: chromeMcpName,
      handlers: new ChromeExtensionTools(bridge, {
        offered,
        policy: () => ctx.policy(),
        activeTurn: (id) => {
          const turn = conversation(id)?.turns.at(-1);
          return turn?.status === "inProgress" ? turn.id : undefined;
        },
      }),
    });
    let removeEndpoint: (() => void) | undefined;
    let removeExtension: (() => void) | undefined;
    const close = async () => {
      bridge.close();
      removeEndpoint?.();
      removeExtension?.();
      await server.close();
    };
    try {
      const endpoint = await bridge.start();
      if (!isCurrent()) throw Error("The signed-in account changed.");
      await server.start();
      if (!isCurrent()) throw Error("The signed-in account changed.");
      removeEndpoint = install
        ? await installChromeExtensionHost(endpoint, isCurrent)
        : await publishChromeExtensionEndpoint(endpoint, isCurrent);
      if (!removeEndpoint) {
        await close();
        return;
      }
      if (!isCurrent()) throw Error("The signed-in account changed.");
      const engine = activation.engine;
      const extension: EngineExtension = {
        id: "chrome-extension",
        reservedMcpServerNames: [chromeMcpName],
        processEnv: () => ({ [chromeMcpTokenEnv]: token }),
        builtinMcpServers(turn) {
          if (
            turn.mode !== turn.conversation.mode ||
            !offered(turn.conversation.id)
          )
            return;
          const url = server.url(turn.conversation.id);
          return url
            ? [
                {
                  name: chromeMcpName,
                  url,
                  bearerTokenEnvVar: chromeMcpTokenEnv,
                  defaultToolsApprovalMode: "approve",
                  startupTimeoutSec: 10,
                  toolTimeoutSec: 660,
                },
              ]
            : undefined;
        },
        developerInstructions: (turn) =>
          offered(turn.conversation.id) ? chromeToolInstructions : undefined,
      };
      removeExtension = engine.extensions.add(extension);
      activation.connection = { bridge, close };
    } catch (error) {
      await close();
      throw error;
    } finally {
      if (isCurrent()) activation.starting = false;
    }
  };

  controls.set(ctx, {
    status,
    onStatusChanged: (listener) => statusListeners.add(listener),
    async configure(enabled) {
      const activation = owner;
      if (!activation || !current(activation) || !chromeExtensionAvailable())
        throw Error("Chrome extension setup is unavailable.");
      if (enabled) {
        if (!browserPolicyOf(ctx.policy()).enabled)
          throw Error("Your administrator has turned off browser tools.");
        await start(activation, true);
        try {
          setEnabled(activation, true);
        } catch (error) {
          await stop(activation);
          throw error;
        }
      } else {
        const closing = stop(activation);
        setEnabled(activation, false);
        await closing;
      }
      return status();
    },
    async revealBundle() {
      if (!owner || !current(owner) || !chromeExtensionAvailable())
        throw Error("Chrome extension setup is unavailable.");
      const error = await shell.openPath(chromeExtensionBundlePath());
      if (error) throw Error("Could not show the Chrome extension folder.");
    },
  });

  ctx.onAccountActivated(() => {
    if (owner) void stop(owner);
    const activation: Activation = {
      identity: ctx.accountActivationIdentity,
      store: ctx.store,
      engine: ctx.engine,
      generation: 0,
      starting: false,
    };
    owner = activation;
    if (
      activation.store.settings.chromeExtensionEnabled === true &&
      chromeExtensionAvailable()
    )
      void start(activation, false).catch((error) => {
        if (current(activation))
          console.error("Chrome extension setup:", error);
      });
  });
  ctx.onSettingsChanged((settings) => {
    if (
      owner &&
      settings.chromeExtensionEnabled !== true &&
      (owner.connection || owner.starting)
    )
      void stop(owner);
  });
  const retire = () => {
    const activation = owner;
    owner = undefined;
    return activation && stop(activation);
  };
  ctx.onAccountDeactivating(retire);
  app.once("will-quit", () => void retire());
}
