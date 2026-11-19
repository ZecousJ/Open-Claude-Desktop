import { z } from "zod";

const pathPattern =
  /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})\/terminal$/;

export const officialCodeTerminalPath = (sessionId: string) =>
  `/v1/code/sessions/${sessionId}/terminal`;

export function officialCodeTerminalRequest(method: string, path: string) {
  const match = method === "POST" && pathPattern.exec(path);
  return match ? { key: match[1] } : undefined;
}

export const officialCodeTerminalInputMaxBytes = 64 * 1024;
export const officialCodeTerminalMaxBytes =
  6 * officialCodeTerminalInputMaxBytes + 256;

const terminalId = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const size = {
  rows: z.number().int().min(1).max(500),
  cols: z.number().int().min(1).max(1000),
};
export const officialCodeTerminalCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), terminalId, ...size }).strict(),
  z
    .object({
      type: z.literal("write"),
      terminalId,
      data: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("resize"), terminalId, ...size }).strict(),
  z.object({ type: z.literal("close"), terminalId }).strict(),
]);
export type OfficialCodeTerminalCommand = z.infer<
  typeof officialCodeTerminalCommand
>;
