/**
 * Every picture is GPT's image model, whatever the conversation's model: the
 * api-image skill (vendor/api-image, MIT) is put in each engine's codex-home,
 * and Codex's own imagegen skill is switched off, so a Claude or Grok
 * conversation draws the same way as a GPT one. The skill's script calls
 * `<base_url>/images/generations` with the key it reads from CODEX_HOME
 * (config.toml's provider, auth.json's OPENAI_API_KEY): the engine writes there
 * its own gateway's address and token, which work only against that local
 * gateway; the gateway passes the request to the service with the GPT group's
 * key (electron/gateway.ts handleImages).
 */
import fs from "node:fs";
import path from "node:path";
import { apiImageFiles } from "./api-image-files";

/** Codex's own image skill, switched off where api-image is installed. */
export function builtinImagegenSkill(codexHome: string) {
  return path.join(codexHome, "skills", ".system", "imagegen", "SKILL.md");
}

/** Writes the skill's files under `<codexHome>/skills/api-image`, when they changed. */
export function installApiImageSkill(codexHome: string) {
  const root = path.join(codexHome, "skills", "api-image");
  for (const [relative, content] of Object.entries(apiImageFiles)) {
    const file = path.join(root, ...relative.split("/"));
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  return root;
}

/** The files the skill reads its provider from: this engine's gateway. */
export function writeImageProviderFiles(
  codexHome: string,
  gatewayUrl: string,
  gatewayToken: string,
) {
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: gatewayToken }, null, 2),
    { mode: 0o600 },
  );
  return {
    model_provider: "claudex",
    model_providers: {
      claudex: {
        name: "Claudex gateway",
        base_url: gatewayUrl,
        env_key: "CLAUDEX_GATEWAY_TOKEN",
        wire_api: "responses",
      },
    },
  };
}
