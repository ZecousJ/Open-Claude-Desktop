import { z } from "zod";

const key = z.string().min(1).max(1000);
const resource = z.enum(["data", "files"]).optional();
export const artifactDataInput = z.discriminatedUnion("method", [
  z.object({ method: z.literal("get"), key, resource }).strict(),
  z.object({ method: z.literal("delete"), key, resource }).strict(),
  z
    .object({
      method: z.literal("set"),
      key,
      value: z.string().max(20 * 1024 * 1024),
      resource,
    })
    .strict(),
  z
    .object({
      method: z.literal("list"),
      prefix: z.string().max(1000).optional(),
      resource,
    })
    .strict(),
]);
