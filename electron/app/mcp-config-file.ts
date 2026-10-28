import {
  recoverNativeExtensionMirror,
  commitNativeMcpServers,
} from "../connectors/native-extension-mirror";
import { resumeDesktopConnectorAuth } from "../connectors/connector-auth";
import fs from "node:fs";
import { McpConfigFile } from "../connectors/mcp-config-file";
import { settingsRefusal } from "../../shared/client-policy";
import { mainState } from "./main-state";
import { policy, sendSettings, ctx } from "../main";

/** Watches the account's MCP configuration file; edits made while the app was closed apply now. */
export function openMcpConfigFile() {
  mainState.mcpConfig = new McpConfigFile(
    mainState.store.root,
    () => mainState.store.settings.mcpServers,
    applyMcpServers,
    () =>
      recoverNativeExtensionMirror(
        mainState.store.root,
        mainState.store.settings.mcpServers,
      ),
  );
  if (fs.existsSync(mainState.mcpConfig.path)) mainState.mcpConfig.reload();
  mainState.mcpConfig.ensure();
  void resumeDesktopConnectorAuth(ctx).catch(() => {});
}

function applyMcpServers(servers: Record<string, unknown>) {
  // The file is another way to edit the servers: the same policy applies.
  const refusal = settingsRefusal(
    mainState.store.settings,
    { ...mainState.store.settings, mcpServers: servers },
    policy(),
  );
  if (refusal) {
    if (mainState.mcpConfig) mainState.mcpConfig.error = refusal;
    return;
  }
  commitNativeMcpServers(mainState.store, servers);
  try {
    sendSettings();
  } catch {
    /* Settings publication already committed. */
  }
  clearTimeout(mainState.restartTimer);
  const restart = () => {
    mainState.restartTimer = undefined;
    if (!mainState.activeAccount || mainState.engine.state.state === "stopped")
      return;
    if (mainState.engine.isBusy())
      return void (mainState.restartTimer = setTimeout(restart, 2000));
    void mainState.engine
      .stop()
      .then(() =>
        mainState.engine.ensure(
          mainState.store.settings.providers.find(
            (p) => p.id === mainState.store.settings.activeProviderId,
          )!,
        ),
      )
      .catch(() => {});
  };
  restart();
}
