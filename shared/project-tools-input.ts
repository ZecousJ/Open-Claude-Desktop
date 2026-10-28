/**
 * The main process's checks for project tools and per-chat connector
 * switches; apart from shared/project-tools.ts so the web page does not load
 * zod with it.
 */
import { z } from "zod";

export const connectorOverridesInput = z.record(
  z.string().min(1).max(500),
  z.boolean(),
);
export const projectToolsInput = z.object({
  webSearch: z.boolean().optional(),
  research: z.boolean().optional(),
  connectors: z.array(z.string().min(1).max(500)).max(500).optional(),
});

/** Bounded sparse conversation choices; global disabled tools remain authoritative. */
export const connectorToolOverridesInput = z
  .record(
    z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    z
      .record(z.string().min(1).max(256), z.boolean())
      .refine((value) => Object.keys(value).length <= 500),
  )
  .refine((value) => Object.keys(value).length <= 128);
