import fs from "node:fs";
import path from "node:path";
declare const __CLAUDEX_SELF_HOSTED_SERVICE_URL__: string;

/**
 * The Claudex service accounts sign in to: sign-in, plans, models and quota
 * come from it. There are no local accounts (owner, 2026-10-02): without a
 * file or CLAUDEX_SUB2API_URL the app uses the default Claudex service.
 */
export interface Sub2ApiConfig {
  version: 1;
  /** Origin (and optional path prefix) of the Sub2API service, no trailing slash. */
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

/** The file wins over `CLAUDEX_SUB2API_URL`; neither means the default service. */
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
  return {
    version: 1,
    baseUrl: normalizeSub2ApiUrl(
      env.CLAUDEX_SUB2API_URL || (typeof __CLAUDEX_SELF_HOSTED_SERVICE_URL__ === "undefined"
        ? "http://127.0.0.1:18080" : __CLAUDEX_SELF_HOSTED_SERVICE_URL__),
    ),
  };
}
