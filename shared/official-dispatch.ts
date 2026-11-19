import { z } from "zod";
import type { OfficialDispatch } from "./dispatch-api";
import { interruptTargetSchema } from "./interrupt-target";
import { remoteFolderValid, type DeviceTrustState } from "./remote-devices";

export interface DispatchReceiving {
  enabled: boolean;
  notifications: boolean;
  folders: string[];
  trust: DeviceTrustState;
}

export interface DispatchReceiver {
  status(): Promise<DispatchReceiving>;
  update(input: { enabled?: boolean; notifications?: boolean }): Promise<DispatchReceiving>;
  addDirectory(): Promise<unknown>;
  removeDirectory(folder: string): Promise<unknown>;
  deviceAccess(input: { id: string; fingerprint: string; action: "approve" | "reject" }): Promise<DispatchReceiving>;
}

const prefix = "/api/claudex/dispatch/";
export const officialDispatchBodyLimit = 512 * 1024;
export function isOfficialDispatchPath(path: string) {
  return path.startsWith(prefix);
}

const identity = z.string().min(1).max(500);
const device = z.object({ deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });
const target = device.extend({ conversationId: identity });
const text = z.string().min(1).max(100_000).refine((value) => !!value.trim());
const cwd = z.string().refine(remoteFolderValid);
const deliveryId = z.object({ id: identity }).strict();
const receiveSettings = z.object({ enabled: z.boolean().optional(), notifications: z.boolean().optional() }).strict();
const access = z.object({ id: identity, fingerprint: identity, action: z.enum(["approve", "reject"]) }).strict();
const decision = z.union([
  z.object({ choice: z.enum(["once", "always", "deny"]) }).strict(),
  z.object({ answers: z.record(identity, z.object({ answers: z.array(z.string()) }).strict()) }).strict(),
  z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.string(), z.unknown()).optional() }).strict(),
]);

interface DispatchRequest {
  method: string;
  url: URL;
  body(): Promise<unknown>;
}

export async function serveOfficialDispatch(
  request: DispatchRequest,
  api: OfficialDispatch | undefined,
  current: () => boolean,
  receiver?: DispatchReceiver,
): Promise<{ body: unknown; status: number; allow?: string }> {
  const unavailable = () => ({ status: 404, body: { error: "Dispatch is unavailable." } });
  const retired = () => ({ status: 401, body: { error: "The active account changed." } });
  const method = (allow: string) => ({ status: 405, allow, body: { error: "Unsupported request." } });
  if (!api) return unavailable();
  if (!current()) return retired();
  const action = request.url.pathname.slice(prefix.length);
  try {
    const respond = async (answer: unknown) => {
      const body = await answer;
      return current() ? { status: 200, body: body ?? null } : retired();
    };
    const post = async <T>(schema: z.ZodType<T>, perform: (input: T) => unknown) => {
      if (request.method !== "POST") return method("POST");
      const input = schema.safeParse(await request.body());
      if (!current()) return retired();
      if (!input.success) return { status: 400, body: { error: "Invalid Dispatch request." } };
      return respond(perform(input.data));
    };
    switch (action) {
      case "status":
        return request.method === "GET" ? await respond(api.status(request.url.searchParams.get("retry") === "1")) : method("GET");
      case "tasks":
        return await post(device.strict(), ({ deviceId }) => api.tasks(deviceId));
      case "directories":
        return await post(device.strict(), ({ deviceId }) => api.directories(deviceId));
      case "deliver":
        return await post(device.extend({ cwd, text, mode: z.enum(["code", "cowork"]) }).strict(), api.deliver);
      case "details":
        return await post(target.strict(), api.details);
      case "follow-up":
        return await post(target.extend({ text }).strict(), api.followUp);
      case "approve":
        return await post(target.extend({ approvalId: z.union([identity, z.number().int()]), decision }).strict(), api.approve);
      case "interrupt":
        return await post(target.extend({ expected: interruptTargetSchema.optional() }).strict(), api.interrupt);
      case "trust":
        return await post(device.strict(), ({ deviceId }) => api.trust(deviceId));
      case "retry":
        return await post(deliveryId, ({ id }) => api.retry(id));
      case "remove":
        return await post(deliveryId, ({ id }) => api.remove(id));
      case "receiving":
        if (!receiver) return unavailable();
        if (request.method === "GET") return await respond(receiver.status());
        if (request.method !== "POST") return method("GET, POST");
        return await post(receiveSettings, receiver.update);
      case "add-directory":
        return receiver ? await post(z.object({}).strict(), receiver.addDirectory) : unavailable();
      case "remove-directory":
        return receiver ? await post(z.object({ folder: cwd }).strict(), ({ folder }) => receiver.removeDirectory(folder)) : unavailable();
      case "device-access":
        return receiver ? await post(access, receiver.deviceAccess) : unavailable();
      default:
        return unavailable();
    }
  } catch (error) {
    if (!current()) return retired();
    const status = (error as { status?: number } | null)?.status;
    return {
      status: status && status >= 400 && status < 600 ? status : 409,
      body: { error: error instanceof Error ? error.message : "Couldn’t connect. Try again." },
    };
  }
}
