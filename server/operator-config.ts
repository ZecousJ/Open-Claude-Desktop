import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../shared/types";
import { endpoint } from "../electron/engine/gateway-chat";

export interface OperatorConfig {
  version: 1;
  providers: Provider[];
  activeProviderId: string;
}
function validate(value: unknown): OperatorConfig {
  if (!value || typeof value !== "object")
    throw Error("Operator model configuration is invalid.");
  const data = value as Record<string, unknown>,
    providers = data.providers;
  if (
    data.version !== 1 ||
    !Array.isArray(providers) ||
    providers.length < 1 ||
    providers.length > 30
  )
    throw Error("Operator model configuration is invalid.");
  const checked: Provider[] = [];
  for (const raw of providers) {
    if (!raw || typeof raw !== "object")
      throw Error("Invalid operator provider.");
    const provider = raw as Record<string, unknown>;
    if (
      typeof provider.id !== "string" ||
      !provider.id ||
      provider.id.length > 100 ||
      typeof provider.name !== "string" ||
      !provider.name ||
      provider.name.length > 100 ||
      typeof provider.model !== "string" ||
      !provider.model ||
      provider.model.length > 200 ||
      typeof provider.baseUrl !== "string" ||
      typeof provider.protocol !== "string" ||
      !["chat", "responses"].includes(provider.protocol) ||
      !Array.isArray(provider.models) ||
      !provider.models.includes(provider.model) ||
      provider.models.some(
        (model) => typeof model !== "string" || !model || model.length > 200,
      )
    )
      throw Error("Invalid operator provider.");
    if (
      provider.transcriptionModel !== undefined &&
      (typeof provider.transcriptionModel !== "string" ||
        !provider.transcriptionModel ||
        provider.transcriptionModel.length > 200)
    )
      throw Error("Invalid transcription model.");
    endpoint(provider.baseUrl, "responses");
    checked.push({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol as Provider["protocol"],
      model: provider.model,
      models: [...new Set(provider.models as string[])],
      ...(provider.transcriptionModel
        ? { transcriptionModel: provider.transcriptionModel as string }
        : {}),
    });
  }
  if (
    new Set(checked.map((provider) => provider.id)).size !== checked.length ||
    typeof data.activeProviderId !== "string" ||
    !checked.some((provider) => provider.id === data.activeProviderId)
  )
    throw Error("Invalid operator default provider.");
  return {
    version: 1,
    providers: checked,
    activeProviderId: data.activeProviderId,
  };
}
export function saveOperatorConfig(root: string, config: OperatorConfig) {
  const checked = validate(config),
    folder = path.join(root, "backend");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const filename = path.join(folder, "operator.json"),
    temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(checked, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
}
export function loadOperatorConfig(root: string): OperatorConfig | undefined {
  const filename = path.join(root, "backend", "operator.json");
  try {
    return validate(JSON.parse(fs.readFileSync(filename, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error(
        "Operator model configuration cannot be read; it has not been overwritten.",
      );
  }
  const baseUrl = process.env.CLAUDEX_OPERATOR_BASE_URL,
    model = process.env.CLAUDEX_OPERATOR_MODEL;
  if (!baseUrl || !model) return;
  const protocol =
    process.env.CLAUDEX_OPERATOR_PROTOCOL === "chat" ? "chat" : "responses";
  const provider: Provider = {
    id: "managed",
    name: process.env.CLAUDEX_OPERATOR_NAME || "Claudex",
    baseUrl,
    protocol,
    model,
    models: [model],
    ...(process.env.CLAUDEX_OPERATOR_TRANSCRIPTION_MODEL
      ? { transcriptionModel: process.env.CLAUDEX_OPERATOR_TRANSCRIPTION_MODEL }
      : {}),
  };
  const config: OperatorConfig = {
    version: 1,
    providers: [provider],
    activeProviderId: provider.id,
  };
  saveOperatorConfig(root, config);
  return config;
}
