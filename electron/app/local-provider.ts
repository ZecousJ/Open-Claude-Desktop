import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { app, nativeTheme } from "electron";
import { z } from "zod";
import type { AuthStatus, Provider } from "../../shared/types";
import { saveOperatorConfig } from "../../server/operator-config";
import { ProviderCredentials } from "../engine/provider-credentials";
import { desktopCredentials, providerServiceScript, push } from "../main";
import { activateAccount, deactivateAccount } from "./account-lifecycle";
import { mainState } from "./main-state";

const workspaceEmail = "workspace@local.invalid";
const providerId = "local-provider";
const connection = z.object({
  baseUrl: z.string().trim().url().max(2000),
  apiKey: z.string().trim().min(1).max(16000),
  model: z.string().trim().min(1).max(200),
  protocol: z.enum(["responses", "chat"]),
}).strict();

const modelList = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(200) })).max(2_000),
});

async function availableModels(baseUrl: string, apiKey: string, selected: string) {
  try {
    const response = await fetch(baseUrl + "/models", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) return [selected];
    const catalog = modelList.safeParse(await response.json());
    if (catalog.success)
      return [...new Set([selected, ...catalog.data.data.map((item) => item.id)])];
  } catch {
    // A proxy can serve completions without providing a model inventory.
  }
  return [selected];
}

function setupTheme() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function status(): AuthStatus {
  return {
    localSetup: true,
    localSetupTheme: setupTheme(),
    hasAccounts: false,
    account: mainState.activeAccount,
  };
}

export async function restoreLocalProvider() {
  if (!mainState.operatorConfig) return;
  const provider = mainState.operatorConfig.providers.find(item => item.id === mainState.operatorConfig?.activeProviderId);
  if (!provider) return;
  const vault = new ProviderCredentials(desktopCredentials.root, providerServiceScript(), desktopCredentials.cipher);
  await vault.initialize([provider]);
  if (!vault.has(provider.id)) return;
  const account = mainState.accounts.listPublicAccounts().find(item => item.email === workspaceEmail);
  if (account) await activateAccount(account, "local-workspace");
}

export function registerLocalProvider(handle: (method: string, handler: (input?: unknown) => unknown) => void) {
  handle("authStatus", status);
  nativeTheme.on("updated", () => {
    if (!mainState.activeAccount)
      push({ type: "local-setup-theme", theme: setupTheme() });
  });
  handle("setupLocalProvider", async raw => {
    if (mainState.activeAccount) throw Error("Close the active connection before changing it.");
    const input = connection.parse(raw);
    const url = new URL(input.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error("Enter an HTTP or HTTPS URL without credentials or query parameters.");
    const protocol = /\/chat\/completions\/?$/.test(url.pathname)
      ? "chat" : /\/responses\/?$/.test(url.pathname) ? "responses" : input.protocol;
    url.pathname = url.pathname.replace(/\/(chat\/completions|responses)\/?$/, "").replace(/\/+$/, "");
    const baseUrl = url.href.replace(/\/$/, "");
    const provider: Provider = {
      id: providerId, name: "Local API", baseUrl,
      protocol, model: input.model, models: await availableModels(baseUrl, input.apiKey, input.model),
    };
    fs.mkdirSync(desktopCredentials.root, { recursive: true, mode: 0o700 });
    const vault = new ProviderCredentials(desktopCredentials.root, providerServiceScript(), desktopCredentials.cipher);
    await vault.initialize([provider]);
    await vault.setKeys({ [provider.id]: input.apiKey }, [provider]);
    const account = mainState.accounts.listPublicAccounts().find(item => item.email === workspaceEmail) ??
      (await mainState.accounts.register(workspaceEmail, randomBytes(24).toString("hex"), "Local workspace")).account;
    const config = { version: 1, providers: [provider], activeProviderId: provider.id } satisfies Parameters<typeof saveOperatorConfig>[1];
    saveOperatorConfig(app.getPath("userData"), config);
    mainState.operatorConfig = config;
    await activateAccount(account, "local-workspace");
    return status();
  });
  handle("logoutAccount", async () => {
    if (mainState.activeAccount) await deactivateAccount();
    return status();
  });
}
