import fs from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { rolloutIndex } from "../workspace/storage-usage";
import { workflowToolName } from "./tool-description";

const sessionMeta = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string(),
    dynamic_tools: z.array(z.object({ name: z.string() })).nullish(),
  }),
});

export async function rolloutOffersWorkflow(codexHome: string, threadId: string) {
  const files = (await rolloutIndex(codexHome)).get(threadId.toLowerCase());
  if (files?.length !== 1) return false;
  const stream = fs.createReadStream(files[0].path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const first of lines) {
      const meta = sessionMeta.safeParse(JSON.parse(first));
      return meta.success && meta.data.payload.id === threadId &&
        meta.data.payload.dynamic_tools?.some((tool) => tool.name === workflowToolName) === true;
    }
    return false;
  } catch {
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}
