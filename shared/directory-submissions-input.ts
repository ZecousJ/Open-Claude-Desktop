import { z } from "zod";

export const directorySubmissionInput = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(["plugin", "mcp"]),
  name: z.string().max(200),
  slug: z.string().max(100),
  url: z.string().max(2000),
  description: z.string().max(10000),
  examples: z.string().max(10000),
  email: z.string().max(254),
  license: z.string().max(200),
  termsAcknowledged: z.boolean(),
  toolsVerified: z.boolean(),
  serverName: z.string().max(200).optional(),
  author: z.string().max(200).optional(),
  supportUrl: z.string().url().startsWith("https://").max(2000).optional(),
  documentationUrl: z
    .string()
    .url()
    .startsWith("https://")
    .max(2000)
    .optional(),
  isAuthless: z.boolean().optional(),
  tools: z.array(z.string().max(200)).max(2000),
  serverUrlType: z
    .enum(["universal", "multiple", "regex", "template"])
    .optional(),
  remoteUrlOptions: z
    .array(
      z.object({
        url: z.string().max(2048),
        label: z.string().max(80).optional(),
      }),
    )
    .max(10)
    .optional(),
  remoteUrlRegex: z.string().max(200).optional(),
  remoteUrlTemplate: z.string().max(400).optional(),
  remoteUserConfig: z
    .object({
      title: z.string().max(80),
      description: z.string().max(120),
      placeholder: z.string().max(253),
      pattern: z.string().max(200),
    })
    .optional(),
  testServerUrl: z.string().max(2048).optional(),
});
