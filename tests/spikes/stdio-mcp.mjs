// Minimal stdio MCP server for the spikes: records which per-thread env it was
// started with, and answers `whoami` with it.
import fs from "node:fs";
import readline from "node:readline";

const conversation = process.env.SPIKE_CONV ?? "";
if (process.env.SPIKE_LOG)
  fs.appendFileSync(
    process.env.SPIKE_LOG,
    JSON.stringify({ pid: process.pid, conversation }) + "\n",
  );
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || !msg.method) return;
  if (msg.method === "initialize")
    return send({
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "spike-stdio", version: "0.0.1" },
      },
    });
  if (msg.method === "tools/list")
    return send({
      id: msg.id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "Report the per-thread env (spike fixture).",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  if (msg.method === "tools/call")
    return send({
      id: msg.id,
      result: {
        content: [
          {
            type: "text",
            text: `CONV:${conversation};META:${JSON.stringify(msg.params?._meta ?? null)}`,
          },
        ],
      },
    });
  send({ id: msg.id, error: { code: -32601, message: "method not found" } });
});
