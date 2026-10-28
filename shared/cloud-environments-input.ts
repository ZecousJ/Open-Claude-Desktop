import { z } from "zod";
import { envFileLimit, envFileProblem } from "./env-file";
import { invalidDomainMessage, validAllowedDomain } from "./allowed-domain";

export const cloudEnvironmentId = z.string().regex(/^(default|[a-f0-9-]{36})$/);
export const cloudEnvironmentInput = z
  .object({
    id: cloudEnvironmentId.optional(),
    name: z.string().trim().min(1).max(200),
    network: z.enum(["none", "trusted", "custom", "full"]),
    allowedDomains: z
      .array(
        z
          .string()
          .trim()
          .max(253)
          .refine(validAllowedDomain, { message: invalidDomainMessage }),
      )
      .max(1000),
    includeDefaultDomains: z.boolean(),
    variables: z
      .string()
      .max(envFileLimit)
      .refine((value) => !envFileProblem(value)),
    setupScript: z.string().max(100_000),
  })
  .strict()
  .refine((input) => input.id !== "default" || input.name === "Default");
