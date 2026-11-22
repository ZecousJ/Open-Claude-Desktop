import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { app, nativeTheme } from "electron";
import { z } from "zod";
import type { AuthStatus, Provider } from "../../shared/types";
import { saveOperatorConfig } from "../../server/operator-config";
import { ProviderCredentials } from "../engine/provider-credentials";
import { ctx, desktopCredentials, providerServiceScript, push } from "../main";
import { activateAccount, deactivateAccount } from "./account-lifecycle";
import { mainState } from "./main-state";

const workspaceEmail = "workspace@local.invalid";
const providerId = "local-provider";
const providerInput = z.object({
  baseUrl: z.string().trim().url().max(2000),
  apiKey: z.string().trim().min(1).max(16000),
  protocol: z.enum(["responses", "chat"]),
}).strict();
const connection = providerInput.extend({ model: z.string().trim().max(200) });

const modelList = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(200) })).max(2_000),
});

function normalizeProvider(input: z.infer<typeof providerInput>) {
  const url = new URL(input.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error("Enter an HTTP or HTTPS URL without credentials or query parameters.");
  const protocol = /\/chat\/completions\/?$/.test(url.pathname)
    ? "chat" : /\/responses\/?$/.test(url.pathname) ? "responses" : input.protocol;
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses)\/?$/, "").replace(/\/+$/, "");
  return { baseUrl: url.href.replace(/\/$/, ""), protocol };
}

async function availableModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const response = await fetch(baseUrl + "/models", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(3500),
  }).catch(() => { throw Error("Could not fetch models from this channel."); });
  if (response.status === 401 || response.status === 403)
    throw Error("The channel rejected the API key.");
  if (response.status === 404 || response.status === 405) return [];
  if (!response.ok) throw Error("Could not fetch models from this channel.");
  const catalog = modelList.safeParse(await response.json().catch(() => undefined));
  if (!catalog.success) throw Error("Could not fetch models from this channel.");
  return [...new Set(catalog.data.data.map((item) => item.id))];
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
  if (account) {
    await activateAccount(account, "local-workspace");
    void refreshLocalModels(vault).catch(() => {});
  }
}

export async function refreshLocalModels(vault = mainState.credentials) {
  const account = mainState.activeAccount;
  const store = mainState.store;
  const config = mainState.operatorConfig;
  const provider = config?.providers.find(item => item.id === config.activeProviderId);
  if (!account || !config || !vault || !provider || provider.id !== providerId) return;
  const current = () => mainState.activeAccount === account && mainState.store === store &&
    mainState.operatorConfig === config && !mainState.accountRetirement.accountRetiring;
  const result = await vault.testProvider(provider, "", current).catch(() => undefined);
  if (!result || !current()) return;
  const ids = result.models.map(id => id.trim()).filter(id => id.length > 0 && id.length <= 200);
  if (!ids.length) return;
  const models = [...new Set([provider.model, ...ids])];
  if (models.length === provider.models.length && models.every((id, index) => id === provider.models[index])) return;
  const saved = store.settings.providers.find(item => item.id === provider.id);
  if (!saved) return;
  provider.models = models;
  saved.models = models;
  saveOperatorConfig(app.getPath("userData"), config);
  store.flush();
  push({ type: "settings", settings: ctx.windowSettings() });
}

export function registerLocalProvider(handle: (method: string, handler: (input?: unknown) => unknown) => void) {
  handle("authStatus", status);
  handle("discoverLocalModels", async raw => {
    if (mainState.activeAccount) throw Error("Close the active connection before changing it.");
    const input = providerInput.parse(raw);
    return availableModels(normalizeProvider(input).baseUrl, input.apiKey);
  });
  nativeTheme.on("updated", () => {
    if (!mainState.activeAccount)
      push({ type: "local-setup-theme", theme: setupTheme() });
  });
  handle("setupLocalProvider", async raw => {
    if (mainState.activeAccount) throw Error("Close the active connection before changing it.");
    const input = connection.parse(raw);
    const { baseUrl, protocol } = normalizeProvider(input);
    const models = await availableModels(baseUrl, input.apiKey).catch(() => []);
    const model = input.model || models[0];
    if (!model) throw Error("Enter a model ID when the channel does not list models.");
    const provider: Provider = {
      id: providerId, name: "Local API", baseUrl,
      protocol, model, models: [...new Set([model, ...models])],
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
