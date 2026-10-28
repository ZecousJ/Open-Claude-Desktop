import fs from "node:fs";
import path from "node:path";
import { defaultClaudexServiceUrl } from "../shared/claudex-service";

/**
 * The Claudex service accounts sign in to: sign-in, plans, models and quota
 * come from it. There are no local accounts: without a file or
 * CLAUDEX_SUB2API_URL the app uses the build's default service, and a build
 * without one has none until the person enters its address.
 */
export interface Sub2ApiConfig {
  version: 1;
  /**
   * Origin (and optional path prefix) of the Sub2API service, no trailing
   * slash; empty while no service is chosen.
   */
  baseUrl: string;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Accepts https, or plain http only on this computer (a local test
 * instance). Credentials, queries and fragments are refused.
 */
export function normalizeSub2ApiUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2000)
    throw Error("Sub2API URL is invalid.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("Sub2API URL is invalid.");
  }
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && loopbackHosts.has(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      "Sub2API URL must use https (plain http only on this computer) and carry no credentials.",
    );
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const fileName = (root: string) => path.join(root, "backend", "sub2api.json");

export function saveSub2ApiConfig(root: string, baseUrl: string) {
  const config: Sub2ApiConfig = {
    version: 1,
    baseUrl: normalizeSub2ApiUrl(baseUrl),
  };
  fs.mkdirSync(path.join(root, "backend"), { recursive: true, mode: 0o700 });
  const filename = fileName(root),
    temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
  return config;
}

/** The file wins over `CLAUDEX_SUB2API_URL`; neither means the build's default service (or none). */
export function loadSub2ApiConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Sub2ApiConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(fileName(root), "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).version !== 1
    )
      throw Error("invalid");
    return {
      version: 1,
      baseUrl: normalizeSub2ApiUrl((parsed as Record<string, unknown>).baseUrl),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error(
        "Sub2API backend configuration cannot be read; it has not been overwritten.",
      );
  }
  const fallback = env.CLAUDEX_SUB2API_URL || defaultClaudexServiceUrl;
  return {
    version: 1,
    baseUrl: fallback ? normalizeSub2ApiUrl(fallback) : "",
  };
}
