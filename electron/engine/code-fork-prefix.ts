import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Item } from "../../shared/types";
import type { CodexRPC } from "./rpc";

const rolloutRow = z.looseObject({
  type: z.string(),
  payload: z.looseObject({
    type: z.string().optional(),
    id: z.string().optional(),
    call_id: z.string().optional(),
    turn_id: z.string().optional(),
    message: z.string().optional(),
    role: z.string().optional(),
    content: z.array(z.unknown()).optional(),
  }),
});

export async function codeForkPrefix(
  rpc: CodexRPC,
  root: string,
  threadId: string,
  turnId: string,
  item?: Item,
) {
  const read = await rpc.call("thread/read", { threadId, includeTurns: false });
  const source = z
    .object({ thread: z.object({ path: z.string().min(1) }) })
    .parse(read);
  const content = fs.readFileSync(source.thread.path, "utf8");
  const lines = content.slice(0, content.lastIndexOf("\n")).split("\n");
  const rows = lines.map((line) => rolloutRow.parse(JSON.parse(line)));
  let cut = lines.length;
  if (item) {
    let activeTurn: string | undefined;
    const matches: number[] = [];
    for (const [index, row] of rows.entries()) {
      if (row.type === "turn_context" || row.payload.type === "task_started")
        activeTurn = row.payload.turn_id;
      const userText = row.payload.content
        ?.flatMap((part) => {
          const text = z
            .object({ type: z.literal("input_text"), text: z.string() })
            .safeParse(part);
          return text.success ? [text.data.text] : [];
        })
        .join("\n");
      if (
        activeTurn === turnId &&
        row.type === "response_item" &&
        (row.payload.id === item.id ||
          row.payload.call_id === item.id ||
          (item.type === "userMessage" &&
            row.payload.type === "message" &&
            row.payload.role === "user" &&
            userText === item.text))
      )
        matches.push(index);
    }
    if (matches.length !== 1)
      throw Error(
        "The selected message is not available in the native Code history.",
      );
    cut = matches[0];
    if (item.type === "agentMessage" || item.type === "userMessage") {
      for (
        let index = cut - 1;
        index >= 0 && rows[index].type === "event_msg";
        index--
      ) {
        const event = rows[index].payload;
        if (
          event.type ===
            (item.type === "agentMessage" ? "agent_message" : "user_message") &&
          event.message === item.text
        )
          cut = index;
      }
    }
  }
  const directory = fs.mkdtempSync(path.join(root, "code-fork-"));
  const file = path.join(directory, "prefix.jsonl");
  try {
    fs.writeFileSync(file, lines.slice(0, cut).join("\n") + "\n", {
      mode: 0o600,
    });
    if (process.getuid?.() === 0) {
      const { uid, gid } = fs.statSync(source.thread.path);
      fs.chownSync(file, uid, gid);
      fs.chownSync(directory, uid, gid);
    }
    return {
      path: file,
      dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
