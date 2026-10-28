import type { RemoteKey } from "./client";
import { Sub2ApiError } from "./http";

import type { TokenPair } from "./client";

import type { LoginResponse } from "./client";
import type { RemoteUser } from "./client";
import type { Json } from "./client";

export const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

export const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function user(value: unknown): RemoteUser | undefined {
  const data = object(value);
  if (!Number.isSafeInteger(data.id) || typeof data.email !== "string")
    return undefined;
  return {
    id: data.id as number,
    email: text(data.email, 254),
    username: text(data.username, 100),
  };
}

/** A login answer (password or email code): tokens, or the TOTP challenge. */
export function loginAnswer(value: unknown): LoginResponse {
  const data = object(value);
  if (data.requires_2fa === true) {
    if (typeof data.temp_token !== "string" || !data.temp_token) malformed();
    return {
      kind: "twoFactor",
      tempToken: data.temp_token,
      maskedEmail: text(data.user_email_masked, 254),
    };
  }
  return { kind: "tokens", tokens: tokens(data), user: user(data.user) };
}

export function tokens(value: unknown): TokenPair {
  const data = object(value);
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    data.access_token.length > 8000 ||
    typeof data.refresh_token !== "string" ||
    !data.refresh_token ||
    data.refresh_token.length > 1000
  )
    malformed();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Math.max(
      60,
      Math.min(count(data.expires_in) || 3600, 30 * 86400),
    ),
  };
}

export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export function malformed(): never {
  throw new Sub2ApiError(
    502,
    "MALFORMED_RESPONSE",
    "The Claudex service sent an unexpected response.",
  );
}

export function key(value: unknown): RemoteKey | undefined {
  const data = object(value);
  if (
    !Number.isSafeInteger(data.id) ||
    typeof data.key !== "string" ||
    !/^[\x21-\x7e]{8,16000}$/.test(data.key)
  )
    return undefined;
  return {
    id: data.id as number,
    name: text(data.name, 200),
    key: data.key,
    groupId: Number.isSafeInteger(data.group_id)
      ? (data.group_id as number)
      : null,
    status: text(data.status, 50),
    createdAt: time(data.created_at),
    lastUsedAt: time(data.last_used_at),
  };
}

export const text = (value: unknown, max = 500) =>
  typeof value === "string" ? value.slice(0, max) : "";

export const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};
