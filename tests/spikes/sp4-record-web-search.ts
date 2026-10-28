/**
 * SP-4 (R45 Q2) recorder: sends one streaming Responses request with web
 * search through a Claudex server (the Sub2API fork) and saves the raw SSE to
 * tests/fixtures/web-search/<name>.sse plus <name>.json (request without the
 * key, status, analysis). Each run is one real, billed upstream request.
 *
 *   SP4_API_KEY=<user key of the group>  (read from the environment only)
 *   SP4_BASE_URL=http://127.0.0.1:18080  (default)
 *   npx tsx tests/spikes/sp4-record-web-search.ts --kind openai|grok \
 *     --model <model> --name <fixture-name> [--query "<text>"]
 *
 * The key is never printed or written; the fixture directory is checked for
 * the key after writing. Use a non-ASCII query so the offset unit can be told
 * apart (the default one is Chinese).
 */
import fs from "node:fs";
import path from "node:path";
import { analyze } from "./web-search-sse";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const kind = arg("kind");
if (kind !== "openai" && kind !== "grok")
  throw new Error("--kind must be openai or grok");
const model = arg("model");
const name = arg("name");
if (!/^[a-z0-9-]+$/.test(name)) throw new Error("--name: a-z, 0-9 and -");
const query = arg(
  "query",
  "用两三句话说明今天上海的天气，并给出你引用的网页来源。",
);
const base = (process.env.SP4_BASE_URL ?? "http://127.0.0.1:18080").replace(
  /\/+$/,
  "",
);
const key = process.env.SP4_API_KEY;
if (!key) throw new Error("Set SP4_API_KEY (it is never printed).");

// The same request shape the R45 gateway rewrite produces: built-in web
// search, sources included; grok models additionally get x_search.
const body = {
  model,
  stream: true,
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: query }],
    },
  ],
  tools: [
    { type: "web_search" },
    ...(kind === "grok" ? [{ type: "x_search" }] : []),
  ],
  include: ["web_search_call.action.sources"],
};

const started = Date.now();
const response = await fetch(`${base}/v1/responses`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  },
  body: JSON.stringify(body),
});
const raw = await response.text();
const dir = path.join(import.meta.dirname, "..", "fixtures", "web-search");
fs.mkdirSync(dir, { recursive: true });
const sse = path.join(dir, `${name}.sse`);
const meta = path.join(dir, `${name}.json`);
fs.writeFileSync(sse, raw);
const analysis = response.ok ? analyze(raw) : undefined;
fs.writeFileSync(
  meta,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      kind,
      model,
      endpoint: "/v1/responses",
      status: response.status,
      contentType: response.headers.get("content-type"),
      durationMs: Date.now() - started,
      request: body,
      analysis,
    },
    null,
    2,
  ) + "\n",
);
for (const file of [sse, meta])
  if (fs.readFileSync(file, "utf8").includes(key)) {
    fs.rmSync(file);
    throw new Error(`${path.basename(file)} contained the key; removed.`);
  }
console.log(
  JSON.stringify(
    {
      status: response.status,
      files: [sse, meta].map((f) => path.relative(process.cwd(), f)),
      offsetUnit: analysis?.offsetUnit,
      annotations: analysis?.annotations.length,
      citationFields: analysis?.citationFields,
    },
    null,
    2,
  ),
);
