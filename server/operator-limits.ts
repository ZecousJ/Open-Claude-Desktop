import fs from "node:fs";
import path from "node:path";

export interface RequestLimits {
  maxConcurrent: number | null;
  requestsPerMinute: number | null;
  dailyTokenLimit: number | null;
  /** Reported input + output tokens per usage week. */
  weeklyTokenLimit: number | null;
  /** The app warns once this percent of the weekly limit is used. */
  weeklyWarnPercent: number;
  /** The usage week resets on this weekday (0 = Sunday) … */
  weeklyResetDay: number;
  /** … at this local hour (0–23). */
  weeklyResetHour: number;
  /** An https page the app offers as "Get more usage". */
  moreUsageUrl: string | null;
}
export interface OperatorLimitsConfig {
  version: 1;
  defaults: Partial<RequestLimits>;
  accounts: Record<string, Partial<RequestLimits>>;
}

// Files written before the weekly fields existed resolve to these values.
const unlimited: RequestLimits = {
  maxConcurrent: null,
  requestsPerMinute: null,
  dailyTokenLimit: null,
  weeklyTokenLimit: null,
  weeklyWarnPercent: 80,
  weeklyResetDay: 1,
  weeklyResetHour: 17,
  moreUsageUrl: null,
};
type Check = (value: unknown) => boolean;
const integer =
  (min: number, max: number, nullable: boolean): Check =>
  (value) =>
    (nullable && value === null) ||
    (Number.isSafeInteger(value) &&
      (value as number) >= min &&
      (value as number) <= max);
const checks: Record<keyof RequestLimits, Check> = {
  maxConcurrent: integer(1, 64, true),
  requestsPerMinute: integer(1, 10000, true),
  dailyTokenLimit: integer(1, 1_000_000_000_000, true),
  weeklyTokenLimit: integer(1, 10_000_000_000_000, true),
  weeklyWarnPercent: integer(1, 100, false),
  weeklyResetDay: integer(0, 6, false),
  weeklyResetHour: integer(0, 23, false),
  moreUsageUrl: (value) => value === null || isMoreUsageUrl(value),
};
const fields = Object.keys(checks) as Array<keyof RequestLimits>;

/** Only plain https pages without embedded credentials may be opened for the person. */
export function isMoreUsageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validatePatch(value: unknown): Partial<RequestLimits> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid backend limit policy.");
  const patch: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!fields.includes(key as keyof RequestLimits))
      throw Error("Unknown backend limit field.");
    if (!checks[key as keyof RequestLimits](item))
      throw Error("Backend limit is out of range.");
    patch[key] = item;
  }
  return patch as Partial<RequestLimits>;
}
export function parseRequestLimits(value: unknown): RequestLimits {
  return { ...unlimited, ...validatePatch(value) };
}
/** True when the provider boundary has something to enforce. */
export function hasEnforcedLimits(limits: RequestLimits) {
  return (
    limits.maxConcurrent !== null ||
    limits.requestsPerMinute !== null ||
    limits.dailyTokenLimit !== null ||
    limits.weeklyTokenLimit !== null
  );
}

function validateConfig(value: unknown): OperatorLimitsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid operator limits configuration.");
  const data = value as Record<string, unknown>,
    accounts = data.accounts;
  if (
    data.version !== 1 ||
    !accounts ||
    typeof accounts !== "object" ||
    Array.isArray(accounts) ||
    Object.keys(accounts).length > 10000
  )
    throw Error("Invalid operator limits configuration.");
  const checked: Record<string, Partial<RequestLimits>> = {};
  for (const [accountId, patch] of Object.entries(accounts)) {
    if (!/^[0-9a-f-]{36}$/.test(accountId))
      throw Error("Invalid account limit identity.");
    checked[accountId] = validatePatch(patch);
  }
  return {
    version: 1,
    defaults: validatePatch(data.defaults ?? {}),
    accounts: checked,
  };
}
export function loadOperatorLimits(root: string): OperatorLimitsConfig {
  const filename = path.join(root, "backend", "limits.json");
  try {
    return validateConfig(JSON.parse(fs.readFileSync(filename, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error(
        "Operator limits cannot be read; the file has not been overwritten.",
      );
  }
  return { version: 1, defaults: {}, accounts: {} };
}
export function saveOperatorLimits(root: string, config: OperatorLimitsConfig) {
  const checked = validateConfig(config),
    folder = path.join(root, "backend");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const filename = path.join(folder, "limits.json"),
    temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(checked, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
}
export function resolveRequestLimits(
  root: string,
  accountId: string,
): RequestLimits {
  const config = loadOperatorLimits(root);
  return { ...unlimited, ...config.defaults, ...config.accounts[accountId] };
}
