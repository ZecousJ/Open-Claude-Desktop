/**
 * SP-4 (R45 Q2) analysis: parse a recorded Responses SSE stream and report the
 * shape of web search results (sources, annotations / citations) and whether
 * annotation offsets count UTF-16 code units, Unicode code points or UTF-8
 * bytes. Used by sp4-record-web-search.ts and its synthetic spike test.
 */
export type Json = Record<string, any>;

export function parseSse(raw: string): Json[] {
  const events: Json[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push({ type: "(unparsed)", data: data.slice(0, 200) });
    }
  }
  return events;
}

type Unit = "utf16" | "codepoints" | "utf8";

function sliceBy(text: string, unit: Unit, start: number, end: number) {
  if (unit === "utf16") return text.slice(start, end);
  if (unit === "codepoints") return Array.from(text).slice(start, end).join("");
  return Buffer.from(text, "utf8").subarray(start, end).toString("utf8");
}

const balanced = (s: string) =>
  [..."()[]"].every((_, i, all) =>
    i % 2 ? true : s.split(all[i]).length === s.split(all[i + 1]).length,
  );

/**
 * 2: the span is a whole bracketed link/marker that names the citation;
 * 1: the span only contains the url, host or title; 0: no match.
 */
function spanScore(span: string, annotation: Json) {
  if (!span) return 0;
  const url: string = annotation.url ?? "";
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const names =
    (url && span.includes(url)) ||
    (host && span.includes(host)) ||
    (annotation.title && span.includes(annotation.title));
  if (!names) return 0;
  const t = span.trim();
  return /^[([]/.test(t) && /[)\]]$/.test(t) && balanced(t) ? 2 : 1;
}

export type Analysis = {
  eventTypes: Record<string, number>;
  outputItemTypes: string[];
  webSearchCalls: Json[];
  annotations: Json[];
  /** Other citation-like fields (e.g. xAI `citations`) found anywhere. */
  citationFields: string[];
  textLength: { utf16: number; codepoints: number; utf8: number };
  nonAscii: boolean;
  /** Match score per unit (2 per exact bracketed span, 1 per containing span). */
  offsetUnit: Record<Unit, number> & { verdict: string };
  usage?: Json;
};

export function analyze(raw: string): Analysis {
  const events = parseSse(raw);
  const eventTypes: Record<string, number> = {};
  for (const e of events) eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
  const done = events.filter((e) => e.type === "response.output_item.done");
  const completed = events.find((e) => e.type === "response.completed");
  const items: Json[] = completed?.response?.output ?? done.map((e) => e.item);
  const messages = items.filter((i) => i.type === "message");
  const parts: Json[] = messages.flatMap((m) =>
    (m.content ?? []).filter((c: Json) => c.type === "output_text"),
  );
  const annotations = parts.flatMap((p) =>
    (p.annotations ?? []).map((a: Json) => ({ ...a, _text: p.text })),
  );
  const offsetUnit = { utf16: 0, codepoints: 0, utf8: 0, verdict: "" };
  for (const a of annotations)
    if (Number.isInteger(a.start_index) && Number.isInteger(a.end_index))
      for (const unit of ["utf16", "codepoints", "utf8"] as Unit[])
        offsetUnit[unit] += spanScore(
          sliceBy(a._text, unit, a.start_index, a.end_index),
          a,
        );
  const text = parts.map((p) => p.text ?? "").join("");
  const ranked = (["utf16", "codepoints", "utf8"] as Unit[]).sort(
    (x, y) => offsetUnit[y] - offsetUnit[x],
  );
  offsetUnit.verdict = !annotations.length
    ? "no annotations with offsets"
    : !/[^\x00-\x7f]/.test(text)
      ? "ascii-only text: units indistinguishable"
      : offsetUnit[ranked[0]] === 0
        ? "no interpretation matched"
        : offsetUnit[ranked[0]] === offsetUnit[ranked[1]]
          ? `ambiguous (${ranked.filter((u) => offsetUnit[u] === offsetUnit[ranked[0]]).join(" = ")})`
          : ranked[0];
  const citationFields = new Set<string>();
  const walk = (value: unknown, at: string) => {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (/citation|source/i.test(k)) citationFields.add(`${at}.${k}`);
      walk(v, Array.isArray(value) ? at : `${at}.${k}`);
    }
  };
  for (const e of events) walk(e, e.type);
  return {
    eventTypes,
    outputItemTypes: items.map((i) => i.type),
    webSearchCalls: items
      .filter((i) => /search/.test(i.type))
      .map((i) => ({ type: i.type, status: i.status, action: i.action })),
    annotations: annotations.map(({ _text, ...a }) => a),
    citationFields: [...citationFields].sort(),
    textLength: {
      utf16: text.length,
      codepoints: Array.from(text).length,
      utf8: Buffer.byteLength(text, "utf8"),
    },
    nonAscii: /[^\x00-\x7f]/.test(text),
    offsetUnit,
    usage: completed?.response?.usage,
  };
}
