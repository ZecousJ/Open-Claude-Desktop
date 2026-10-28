/** Interactive desktop QA: loopback provider + actual Codex; no credentials. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
type Json = Record<string, any>;
function flattenTools(tools: Json[], namespace?: string): Json[] {
  return tools.flatMap((tool) =>
    tool.type === "namespace"
      ? flattenTools(tool.tools ?? [], tool.name)
      : [{ ...tool, namespace }],
  );
}
function textOf(messages: Json[]) {
  return messages
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : (item.content ?? []).map((part: Json) => part.text ?? "").join("\n"),
    )
    .join("\n");
}
function responseEvents(
  output: Json[],
  responseId: string,
  requestedModel: string,
) {
  let sequence = 0;
  const events: Json[] = [];
  const add = (event: Json) =>
    events.push({ ...event, sequence_number: sequence++ });
  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage: {
      input_tokens: 30,
      output_tokens: 8,
      total_tokens: 38,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  add({
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  });
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    add({
      type: "response.output_item.added",
      output_index: i,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "message"
          ? { content: [] }
          : item.type === "custom_tool_call"
            ? { input: "" }
            : { arguments: "" }),
      },
    });
    if (item.type === "message") {
      const part = item.content[0];
      add({
        type: "response.content_part.added",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        part: { ...part, text: "" },
      });
      add({
        type: "response.output_text.delta",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        delta: part.text,
      });
      add({
        type: "response.output_text.done",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        text: part.text,
      });
      add({
        type: "response.content_part.done",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        part,
      });
    } else if (item.type === "custom_tool_call") {
      add({
        type: "response.custom_tool_call_input.delta",
        output_index: i,
        item_id: item.id,
        delta: item.input,
      });
      add({
        type: "response.custom_tool_call_input.done",
        output_index: i,
        item_id: item.id,
        input: item.input,
      });
    } else {
      add({
        type: "response.function_call_arguments.delta",
        output_index: i,
        item_id: item.id,
        delta: item.arguments,
      });
      add({
        type: "response.function_call_arguments.done",
        output_index: i,
        item_id: item.id,
        arguments: item.arguments,
      });
    }
    add({ type: "response.output_item.done", output_index: i, item });
  }
  add({ type: "response.completed", response });
  return events;
}

const root = path.resolve(
  process.argv[2] ?? "../../work/preview/live-artifact-profile",
);
if (fs.existsSync(path.join(root, "settings.json")))
  throw Error("Use an unused isolated QA profile.");
fs.mkdirSync(root, { recursive: true });
let requests = 0;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    const history: Json[] = body.input ?? [];
    const lastUser = [...history].reverse().find((i) => i.role === "user");
    const update = textOf(lastUser ? [lastUser] : []).includes("UPDATE");
    const callId = `qa_${update ? "update" : "create"}_${history.filter((i) => i.role === "user").length}`;
    const result = history.find(
      (i) => i.type === "custom_tool_call_output" && i.call_id === callId,
    );
    let output: Json[];
    if (!result) {
      const tool = flattenTools(body.tools ?? []).find(
        (t) => t.name === "apply_patch",
      );
      if (!tool) throw Error("Native apply_patch was not advertised.");
      const initial =
        '<html><head><title>Live generated card</title></head><body style="background:#1a1a1a;color:#eee;font-family:system-ui;padding:32px"><h1>Live generated card</h1><p id="count">0</p><button onclick="document.getElementById(\'count\').textContent=Number(document.getElementById(\'count\').textContent)+1">Add 1</button></body></html>';
      const old = update
        ? fs
            .readFileSync(path.join(root, "workspace/live-card.html"), "utf8")
            .trimEnd()
        : initial;
      const count = Number(
        /UPDATE\s+(\d+)/.exec(textOf(lastUser ? [lastUser] : []))?.[1] ?? 2,
      );
      const current = old
        .replace(/Add \d+/g, `Add ${count}`)
        .replace(/\+\d+(?=")/, `+${count}`);
      const patch = update
        ? `*** Begin Patch\n*** Update File: live-card.html\n@@\n-${old}\n+${current}\n*** End Patch`
        : `*** Begin Patch\n*** Add File: live-card.html\n+${old}\n*** End Patch`;
      output = [
        {
          type: "custom_tool_call",
          id: `fc_${requests}`,
          call_id: callId,
          name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          input: patch,
          status: "completed",
        },
      ];
    } else
      output = [
        {
          id: `msg_${requests}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: update
                ? "Updated the generated card to Add 2."
                : "Created the generated card.",
              annotations: [],
            },
          ],
        },
      ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of responseEvents(output, `resp_${requests}`, body.model))
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
    console.log(
      JSON.stringify({
        request: requests,
        stage: update ? "update" : "create",
        tool: !result,
      }),
    );
  } catch (e) {
    res
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: { message: String(e) } }));
    console.error(String(e));
  }
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as import("node:net").AddressInfo).port;
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      theme: "dark",
      name: "Reference test",
      providers: [
        {
          id: "qa",
          name: "Loopback QA",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          protocol: "responses",
          model: "gpt-5.2-codex",
          models: ["gpt-5.2-codex"],
        },
      ],
      activeProviderId: "qa",
      sandbox: "workspace-write",
      effort: "low",
      instructions: "Use apply_patch for requested file changes.",
      mcpServers: {},
    }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ profile: root, port }));
});
