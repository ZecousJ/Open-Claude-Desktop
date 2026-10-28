/**
 * SP-4 analyzer self-check on synthetic streams (no network). Real recordings
 * go to tests/fixtures/web-search/ via sp4-record-web-search.ts; when present,
 * this test also prints their analysis.
 *
 * Run: npx tsx --test tests/spikes/sp4-analyze.spike.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { analyze, type Json } from "./web-search-sse";

const url = "https://weather.example.com/shanghai";
const lead = "上海今天多云，气温 18–24°C 😀 ";
const link = `([weather.example.com](${url}))`;
const text = lead + link;

function stream(start: number, end: number) {
  const item: Json = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        annotations: [
          {
            type: "url_citation",
            start_index: start,
            end_index: end,
            url,
            title: "Shanghai weather",
          },
        ],
      },
    ],
  };
  const search = {
    id: "ws_1",
    type: "web_search_call",
    status: "completed",
    action: {
      type: "search",
      query: "上海 天气",
      sources: [{ type: "url", url }],
    },
  };
  const events = [
    { type: "response.created", response: { output: [] } },
    { type: "response.output_item.done", output_index: 0, item: search },
    { type: "response.output_item.done", output_index: 1, item },
    { type: "response.completed", response: { output: [search, item] } },
  ];
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

test("offset unit is told apart on non-ASCII text", () => {
  const u16 = analyze(stream(lead.length, text.length));
  assert.equal(u16.offsetUnit.verdict, "utf16");
  const cps = Array.from(lead).length;
  assert.equal(
    analyze(stream(cps, cps + Array.from(link).length)).offsetUnit.verdict,
    "codepoints",
  );
  const bytes = Buffer.byteLength(lead);
  assert.equal(
    analyze(stream(bytes, bytes + Buffer.byteLength(link))).offsetUnit.verdict,
    "utf8",
  );
  assert.deepEqual(u16.outputItemTypes, ["web_search_call", "message"]);
  assert.equal(u16.webSearchCalls[0].action.sources[0].url, url);
  assert(u16.citationFields.some((f) => f.endsWith(".sources")));
});

test("recorded fixtures (if any)", () => {
  const dir = path.join(import.meta.dirname, "..", "fixtures", "web-search");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".sse"))
    : [];
  for (const f of files) {
    const a = analyze(fs.readFileSync(path.join(dir, f), "utf8"));
    console.log(f, JSON.stringify(a.offsetUnit), a.citationFields.join(","));
  }
});
