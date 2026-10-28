import readline from "node:readline";
import { openSseConnector } from "../electron/connectors/connector-sse";
import { connectorFetch } from "../runner/src/connectors";

const headers = JSON.parse(process.env.CLAUDEX_MCP_HEADERS ?? "{}");
delete process.env.CLAUDEX_MCP_HEADERS;
const address = process.env.CLAUDEX_MCP_URL ?? "";
const transport = await openSseConnector(
  address,
  connectorFetch({ level: "full" }),
  headers,
  (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
);
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
input.on("line", (line) => {
  if (line.length > 2_000_000) {
    transport.close();
    process.exitCode = 1;
    return;
  }
  try {
    void transport.send(JSON.parse(line)).catch(() => {
      transport.close();
      process.exitCode = 1;
      input.close();
    });
  } catch {
    transport.close();
    process.exitCode = 1;
    input.close();
  }
});
input.on("close", () => transport.close());
await transport.completed.catch(() => {
  process.exitCode = 1;
  input.close();
});
