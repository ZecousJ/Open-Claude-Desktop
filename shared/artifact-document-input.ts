import { z } from "zod";

export const documentTitleInput = z.string().trim().min(1).max(200);
export const documentHtmlInput = z.string().max(10 * 1024 * 1024);
export const documentCloudInput = z
  .object({
    server: z.string().min(1).max(500),
    service: z.enum(["gdrive", "notion"]),
    title: documentTitleInput,
    markdown: z.string().max(2 * 1024 * 1024),
  })
  .strict();

export const documentBytesInput = z
  .string()
  .max(16 * 1024 * 1024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
