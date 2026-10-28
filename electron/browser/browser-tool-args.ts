import { z } from "zod";
import { type McpCallResult, type McpContent } from "./mcp-server";

// ---------------------------------------------------------------------------
// Arguments

export const tabId = z
  .string()
  .regex(/^tab-\d{1,9}$/, "Use a tab id from tabs_list (tab-N).")
  .optional();

export const ref = z
  .string()
  .regex(/^ref_\d{1,9}$/, "Use an element ref from read_page or find (ref_N).");

export const coordinate = z.tuple([z.number().finite(), z.number().finite()]);

const serverName = z.string().min(1).max(64);

export const schemas = {
  tabs_list: z.object({}).strict(),
  tab_new: z.object({ url: z.string().max(8192).optional() }).strict(),
  tab_select: z.object({ tabId: tabId.unwrap() }).strict(),
  tab_close: z.object({ tabId: tabId.unwrap() }).strict(),
  navigate: z.object({ url: z.string().min(1).max(8192), tabId }).strict(),
  screenshot: z
    .object({ tabId, fullPage: z.boolean().optional(), ref: ref.optional() })
    .strict(),
  read_page: z
    .object({
      tabId,
      ref: ref.optional(),
      filter: z.enum(["all", "interactive"]).optional(),
      maxChars: z.number().int().min(1000).max(200_000).optional(),
    })
    .strict(),
  find: z.object({ query: z.string().min(1).max(500), tabId }).strict(),
  get_text: z
    .object({
      tabId,
      maxChars: z.number().int().min(1000).max(200_000).optional(),
    })
    .strict(),
  click: z
    .object({
      ref: ref.optional(),
      coordinate: coordinate.optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
      modifiers: z.string().max(100).optional(),
      tabId,
    })
    .strict(),
  hover: z
    .object({ ref: ref.optional(), coordinate: coordinate.optional(), tabId })
    .strict(),
  type: z
    .object({ text: z.string().max(100_000), ref: ref.optional(), tabId })
    .strict(),
  key: z
    .object({
      keys: z.string().min(1).max(1000),
      repeat: z.number().int().min(1).max(100).optional(),
      tabId,
    })
    .strict(),
  scroll: z
    .object({
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(50).optional(),
      ref: ref.optional(),
      coordinate: coordinate.optional(),
      tabId,
    })
    .strict(),
  form_input: z
    .object({
      ref,
      value: z.union([z.string().max(100_000), z.boolean(), z.number()]),
      tabId,
    })
    .strict(),
  handle_dialog: z
    .object({
      accept: z.boolean(),
      text: z.string().max(10_000).optional(),
      tabId,
    })
    .strict(),
  console: z
    .object({
      pattern: z.string().max(500).optional(),
      onlyErrors: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      tabId,
    })
    .strict(),
  network: z
    .object({
      urlPattern: z.string().max(500).optional(),
      onlyFailed: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      tabId,
    })
    .strict(),
  resize: z
    .object({
      viewport: z.union([
        z.enum(["desktop", "mobile", "tablet"]),
        z
          .object({
            width: z.number().int().min(1).max(10_000),
            height: z.number().int().min(1).max(10_000),
          })
          .strict(),
      ]),
    })
    .strict(),
  evaluate: z
    .object({ expression: z.string().min(1).max(100_000), tabId })
    .strict(),
  preview_list: z.object({}).strict(),
  preview_start: z.object({ name: serverName }).strict(),
  preview_stop: z.object({ name: serverName }).strict(),
  preview_logs: z
    .object({
      name: serverName,
      lines: z.number().int().min(1).max(2000).optional(),
      search: z.string().max(500).optional(),
      level: z.enum(["all", "error"]).optional(),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof schemas;

export function parseArgs<N extends ToolName>(
  name: N,
  args: Record<string, unknown>,
): z.infer<(typeof schemas)[N]> {
  const result = schemas[name].safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ToolError(
      `Invalid arguments for ${name}: ${where}${issue?.message ?? "invalid"}.`,
    );
  }
  return result.data as z.infer<(typeof schemas)[N]>;
}

export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Results

export const ok = (text: string, ...more: McpContent[]): McpCallResult => ({
  content: [{ type: "text", text }, ...more],
});

export const failed = (text: string): McpCallResult => ({
  content: [{ type: "text", text }],
  isError: true,
});
