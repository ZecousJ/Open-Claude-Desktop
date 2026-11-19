import { z } from "zod";
import { actionVerificationError, actionVerificationMarker } from "./action-verification";
import type { AccountProfileAPI } from "./account-profile-api";
import { apiKeyNameProblem, maskedKey, type ApiKey, type ApiKeysAPI } from "./api-keys-api";

const prefix = "/api/claudex/api-management/";
export const apiManagementBodyLimit = 4096;
export const isApiManagementPath = (path: string) => path.startsWith(prefix);

export type ApiManagement = ApiKeysAPI & Pick<AccountProfileAPI, "sendActionVerification" | "confirmActionVerification">;

const idSchema = z.number().int().positive();
const group = z.strictObject({ providerId: z.string().min(1).max(40), groupId: idSchema });
const key = z.strictObject({ name: z.string(), groupId: idSchema });
const code = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
const empty = z.strictObject({});
const masked = (item: ApiKey): ApiKey => ({ ...item, key: maskedKey(item.key) });

export function apiManagementFailure(message: string, status: number, detail?: { code?: string; actionLabel?: string; seconds?: number }) {
  return { status, data: { error: { message, ...detail } } };
}

export async function executeApiManagement(
  method: string,
  url: URL,
  readBody: () => Promise<unknown>,
  api: ApiManagement,
  check: () => void,
): Promise<{ status: number; data?: unknown }> {
  const target = url.pathname.slice(prefix.length);
  const match = /^keys\/([1-9]\d*)(\/copy)?$/.exec(target);
  const id = match ? idSchema.safeParse(Number(match[1])) : undefined;
  const read = async <T>(schema: z.ZodType<T>) => {
    const body = schema.parse(await readBody());
    check();
    return body;
  };
  const ok = (data: unknown, status = 200) => {
    check();
    return { status, data };
  };
  try {
    check();
    if (method === "GET" && target === "groups" && (!url.search || url.search === "?fresh=1"))
      return ok(await api.apiGroups(url.search !== ""));
    if (url.search) return apiManagementFailure("Invalid API request.", 400);
    if (method === "GET" && target === "rates") return ok(await api.groupRates());
    if (method === "GET" && target === "keys") return ok((await api.apiKeys()).map(masked));
    if (method === "POST" && target === "groups") {
      const { providerId, groupId } = await read(group);
      return ok(await api.setApiGroup(providerId, groupId));
    }
    if (method === "POST" && target === "keys") {
      const input = await read(key);
      const problem = apiKeyNameProblem(input.name);
      return problem ? apiManagementFailure(problem, 400) : ok(masked(await api.createApiKey(input)), 201);
    }
    if (method === "POST" && match?.[2] && id?.success) {
      await read(empty);
      const item = (await api.apiKeys()).find((entry) => entry.id === id.data);
      return item ? ok({ key: item.key }) : apiManagementFailure("That key isn't in your list any more.", 404);
    }
    if (method === "DELETE" && match && !match[2] && id?.success) {
      await api.deleteApiKey(id.data);
      return ok(undefined, 204);
    }
    if (method === "POST" && target === "verification/send") {
      await read(empty);
      return ok(await api.sendActionVerification());
    }
    if (method === "POST" && target === "verification/confirm")
      return ok(await api.confirmActionVerification((await read(code)).code));
    return apiManagementFailure("API operation not found.", 404);
  } catch (error) {
    check();
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
    if (error instanceof z.ZodError) return apiManagementFailure("Invalid API request.", 400);
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status : 503;
    const detail = actionVerificationError(error);
    const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message.split(actionVerificationMarker)[0].trim().slice(0, 500) : "API management is unavailable.";
    return apiManagementFailure(message || "API management is unavailable.", status, detail);
  }
}
