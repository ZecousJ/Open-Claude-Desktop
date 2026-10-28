import fs from "node:fs";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import { sessionExport } from "../../shared/session-export";
import { createZip } from "../workspace/zip";

/** Local transcript export. */
export function exportSessionArchive(
  conversation: Conversation,
  downloads: string,
  now = Date.now(),
) {
  const { exportedAt, session, messages } = sessionExport(conversation, now);
  const archive = createZip([
    {
      name: "transcript.jsonl",
      data: Buffer.from(
        messages.map((message) => JSON.stringify(message)).join("\n") +
          (messages.length ? "\n" : ""),
      ),
    },
    {
      name: "metadata.json",
      data: Buffer.from(JSON.stringify({ exportedAt, ...session }, null, 2)),
    },
  ]);
  for (let suffix = 0; ; suffix++) {
    const file = path.join(
      downloads,
      `session-export-${now}${suffix ? `-${suffix}` : ""}.zip`,
    );
    try {
      fs.writeFileSync(file, archive, { flag: "wx", mode: 0o600 });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
