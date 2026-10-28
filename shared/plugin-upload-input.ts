import { z } from "zod";

const id = z.string().uuid();
export const pluginUploadInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), name: z.string().min(1).max(512) }),
  z.object({
    action: z.literal("append"),
    id,
    data: z
      .string()
      .max(1400000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
  z.object({
    action: z.literal("finish"),
    id,
    overwrite: z.boolean().optional(),
  }),
  z.object({ action: z.literal("cancel"), id }),
]);
