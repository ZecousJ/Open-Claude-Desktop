import { z } from "zod";
const historySearchPage = z.strictObject({
  offset: z.number().int().min(0).max(100000),
  archive: z.enum(["all", "active", "archived"]),
  starredOnly: z.boolean().optional(),
});
export const historySearchInput = z
  .object({
    query: z
      .string()
      .trim()
      .refine(
        (value) => Array.from(value).length <= 200,
        "Search is limited to 200 characters",
      ),
    mode: z.enum(["chat", "cowork", "code"]).optional(),
    projectId: z.string().min(1).max(100).optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
    page: historySearchPage.optional(),
  })
  .strict();
export const historySearchResult = z.object({
  results: z.array(
    z.object({
      conversationId: z.string().min(1),
      title: z.string(),
      mode: z.enum(["chat", "cowork", "code"]),
      projectId: z.string().optional(),
      archived: z.boolean(),
      updatedAt: z.number().finite(),
      turnId: z.string().optional(),
      snippet: z.string().optional(),
    }),
  ),
});
export type HistorySearchHit = z.infer<
  typeof historySearchResult
>["results"][number];
export type HistorySearchOptions = {
  mode?: "chat" | "cowork" | "code";
  projectId?: string;
  includeArchived?: boolean;
  limit?: number;
  page?: z.infer<typeof historySearchPage>;
};
