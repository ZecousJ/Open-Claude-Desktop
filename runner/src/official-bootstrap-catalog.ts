import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bootstrapCatalog, compactBootstrap } from "../../shared/official-bootstrap-catalog";

export function bootstrapCompactor(root: string) {
  const file = path.join(root, "data", "bootstrap-defaults.json");
  const messages: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).gated_messages?.messages : undefined;
  const catalog = bootstrapCatalog.safeParse({
    revision: createHash("sha256").update(JSON.stringify(messages ?? null)).digest("hex"), messages,
  });
  return (body: Uint8Array, revision: string) => {
    if (!catalog.success || revision !== catalog.data.revision) return body;
    return Buffer.from(JSON.stringify(compactBootstrap(JSON.parse(Buffer.from(body).toString("utf8")), catalog.data)));
  };
}
