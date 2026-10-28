import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  eventsSubprotocols,
  isOpenableUrl,
  isWebMethodName,
  isWebTicket,
  parseBrowserFrame,
  parseRpcRequest,
  parseRpcResponse,
  parseServerFrame,
  parseTicketResponse,
  rpcError,
  rpcRequest,
  runnerLinkSubprotocol,
  ticketFromSubprotocols,
  webAuthRoutes,
  webCloseCodes,
  webClientName,
  webErrorCodes,
  webEventsSubprotocol,
  webGoMethodRoutes,
  webHeaders,
  webLimits,
  webPaths,
  webProtocolVersion,
  webRefreshCookie,
  webTicketSubprotocolPrefix,
} from "../../shared/web-protocol";
import { WebProtocolError } from "../../shared/web-wire";
import {
  base64ToBytes,
  bytesToBase64,
  decodeWireValue,
  encodeWireValue,
} from "../../shared/web-wire";
import {
  parseGoFrame,
  parseRunnerFrame,
  webRunnerOps,
} from "../../shared/web-runner-frames";
import {
  joinConversation,
  parseConversationDoc,
  parseTurnDoc,
  splitConversation,
  webDocSchema,
  type TurnDoc,
} from "../../shared/web-docs";
import { webRemoteGoMethods } from "../../shared/web-bridge-methods";
import type { Conversation } from "../../shared/types";

type Json = Record<string, any>;
const dir = fileURLToPath(
  new URL(
    "../../backend/backend/internal/claudex/webproto/testdata/",
    import.meta.url,
  ),
);
const golden = (name: string): Json =>
  JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
const goldenNames = fs
  .readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .sort();

/** A parser must accept the sample and give back the same JSON. */
function roundTrips(parse: (value: Json) => unknown, name: string) {
  const value = golden(name);
  assert.deepEqual(
    JSON.parse(JSON.stringify(parse(structuredClone(value)))),
    value,
    `${name} survives parsing`,
  );
  // Text input behaves like object input.
  assert.deepEqual(
    JSON.parse(JSON.stringify(parse(JSON.stringify(value) as any))),
    value,
  );
}

const byPrefix: [string, (name: string) => void][] = [
  ["events.browser.", (n) => roundTrips(parseBrowserFrame, n)],
  ["events.server.", (n) => roundTrips(parseServerFrame, n)],
  ["link.runner.", (n) => roundTrips(parseRunnerFrame, n)],
  ["link.go.", (n) => roundTrips(parseGoFrame, n)],
  ["doc.turn.", (n) => roundTrips(parseTurnDoc, n)],
  ["doc.conversation.", (n) => roundTrips(parseConversationDoc, n)],
  ["doc.split", () => undefined], // its own test below
  [
    "rpc.request",
    (n) => {
      const parsed = parseRpcRequest(golden(n));
      assert.deepEqual(rpcRequest(parsed.args), golden(n));
    },
  ],
  [
    "rpc.response.",
    (n) => {
      const { status, body } = golden(n);
      const parsed = parseRpcResponse(status, body);
      assert.equal(parsed.ok, body.ok, `${n} keeps ok`);
      if (!parsed.ok) assert.deepEqual(parsed.error, body.error);
      else assert.deepEqual(parsed.value, body.value);
    },
  ],
  ["ticket.request", (n) => assert.ok(golden(n).tabId)],
  [
    "ticket.response",
    (n) => assert.deepEqual(parseTicketResponse(golden(n)), golden(n)),
  ],
  ["ticket.subprotocols", () => undefined],
  ["bytes", () => undefined],
  ["invalid", () => undefined],
  ["constants", () => undefined],
];

test("every golden sample is registered and parses", () => {
  assert.ok(goldenNames.length > 30);
  for (const name of goldenNames) {
    const rule = byPrefix.find(([prefix]) => name.startsWith(prefix));
    assert.ok(rule, `${name}.json is registered in tests/web-protocol.test.ts`);
    rule[1](name);
  }
});

test("constants match the shared sample (and so the Go mirror)", () => {
  const c = golden("constants");
  assert.equal(c.version, webProtocolVersion);
  assert.equal(c.docSchema, webDocSchema);
  assert.deepEqual(c.paths, webPaths);
  assert.deepEqual(c.authRoutes, webAuthRoutes);
  assert.deepEqual(c.headers, webHeaders);
  assert.equal(c.clientName, webClientName);
  assert.equal(c.refreshCookie, webRefreshCookie);
  assert.equal(c.eventsSubprotocol, webEventsSubprotocol);
  assert.equal(c.ticketSubprotocolPrefix, webTicketSubprotocolPrefix);
  assert.equal(c.runnerLinkSubprotocol, runnerLinkSubprotocol);
  assert.deepEqual(c.limits, webLimits);
  assert.deepEqual(c.closeCodes, webCloseCodes);
  assert.deepEqual(c.errorCodes, webErrorCodes);
  assert.deepEqual(c.runnerOps, webRunnerOps);
});

test("invalid samples are refused", () => {
  const parsers: Record<string, (value: Json) => unknown> = {
    browser: parseBrowserFrame,
    server: parseServerFrame,
    runner: parseRunnerFrame,
    go: parseGoFrame,
    turn: parseTurnDoc,
    conversation: parseConversationDoc,
    "rpc-request": parseRpcRequest,
  };
  for (const { kind, why, frame } of golden("invalid").cases) {
    const parse = parsers[kind];
    assert.ok(parse, `invalid kind ${kind}`);
    assert.throws(() => parse(frame), WebProtocolError, `${kind}: ${why}`);
  }
  assert.throws(() => parseServerFrame("not json"), WebProtocolError);
  assert.throws(() => parseRunnerFrame("[1]"), WebProtocolError);
});

test("bytes travel as {$bytes: base64}", () => {
  for (const { hex, base64 } of golden("bytes").cases) {
    const bytes = Uint8Array.from(
      (hex as string).match(/../g)?.map((h) => parseInt(h, 16)) ?? [],
    );
    assert.equal(bytesToBase64(bytes), base64);
    assert.deepEqual(base64ToBytes(base64), bytes);
    assert.equal(Buffer.from(bytes).toString("base64"), base64);
  }
  const random = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(random)), random);
  assert.throws(() => base64ToBytes("abc"), WebProtocolError);
  assert.throws(() => base64ToBytes("ab!="), WebProtocolError);

  const value = {
    pcm: new Uint8Array([104, 101, 108, 108, 111]),
    nested: [{ data: new Uint8Array([0]) }],
    skipped: undefined,
    plain: 1,
  };
  const wire = encodeWireValue(value);
  assert.deepEqual(wire, {
    pcm: { $bytes: "aGVsbG8=" },
    nested: [{ data: { $bytes: "AA==" } }],
    plain: 1,
  });
  assert.deepEqual(decodeWireValue(JSON.parse(JSON.stringify(wire))), {
    pcm: value.pcm,
    nested: [{ data: value.nested[0]!.data }],
    plain: 1,
  });
  // An object with $bytes and other keys is ordinary data.
  assert.deepEqual(decodeWireValue({ $bytes: "AA==", x: 1 }), {
    $bytes: "AA==",
    x: 1,
  });
  const request = parseRpcRequest(golden("rpc.request"));
  assert.deepEqual(request.args[1], new TextEncoder().encode("hello"));
});

test("RPC answers become values or errors with code and details", () => {
  const limit = golden("rpc.response.handler-error");
  const parsed = parseRpcResponse(limit.status, limit.body);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  const error = rpcError(parsed.error);
  assert.equal(error.message, limit.body.error.message);
  assert.equal(error.code, "CLAUDEX_USAGE_LIMIT_EXCEEDED");
  assert.deepEqual(error.details, limit.body.error.details);
  assert.equal(rpcError({ message: "x" }).code, undefined);

  assert.deepEqual(parseRpcResponse(200, { ok: true }), {
    ok: true,
    value: undefined,
  });
  // Bodies that are not ours (a proxy's HTML page) still give a message.
  const expired = parseRpcResponse(401, "<html>");
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.error.message, /session has expired/);
  const proxy = parseRpcResponse(502, null);
  assert.ok(!proxy.ok && /502/.test(proxy.error.message));
  const odd = parseRpcResponse(500, { ok: true });
  assert.equal(odd.ok, false);
  assert.throws(() => parseRpcResponse(200, {}), WebProtocolError);
});

test("tickets ride in Sec-WebSocket-Protocol, never the URL", () => {
  const { ticket } = golden("ticket.response");
  assert.ok(isWebTicket(ticket));
  assert.deepEqual(eventsSubprotocols(ticket), [
    "claudex.v1",
    `ticket.${ticket}`,
  ]);
  assert.throws(() => eventsSubprotocols("short"), WebProtocolError);
  for (const { header, ticket: expected } of golden("ticket.subprotocols")
    .cases)
    assert.equal(ticketFromSubprotocols(header), expected, String(header));
  assert.throws(
    () => parseTicketResponse({ ticket: "x", expires_in: 30 }),
    WebProtocolError,
  );
});

test("method names and openable URLs", () => {
  for (const name of ["send", "snapshot", "getFavicons", "a"])
    assert.ok(isWebMethodName(name), name);
  for (const name of ["", "Send", "../x", "send/x", "a".repeat(65), 1])
    assert.ok(!isWebMethodName(name), String(name));
  assert.ok(isOpenableUrl("https://pay.example.com/x"));
  assert.ok(isOpenableUrl("/desktop-pay?order=1"));
  for (const url of [
    "http://x.test/",
    "//evil.test/",
    "javascript:alert(1)",
    "data:text/html,x",
    "",
    "/\\evil.test/",
    "/\t/evil.test/",
    "/\n/evil.test/",
    "https:///evil.test",
    "HTTPS://pay.example.com/x",
    "https://pay.example.com/a b",
  ])
    assert.ok(!isOpenableUrl(url), url);
});

test("a __proto__ key in wire JSON stays data", () => {
  const decoded = decodeWireValue(
    JSON.parse('{"a":{"__proto__":{"polluted":true}}}'),
  ) as { a: Record<string, unknown> };
  assert.equal(Object.getPrototypeOf(decoded.a), Object.prototype);
  assert.equal((decoded.a as { polluted?: boolean }).polluted, undefined);
  assert.ok(Object.hasOwn(decoded.a, "__proto__"));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  const encoded = encodeWireValue(decoded) as { a: object };
  assert.equal(Object.getPrototypeOf(encoded.a), Object.prototype);
  assert.equal(
    JSON.stringify(encoded),
    '{"a":{"__proto__":{"polluted":true}}}',
  );
});

test("every remote-go call has a Go endpoint", () => {
  assert.deepEqual(
    Object.keys(webGoMethodRoutes).sort(),
    [...webRemoteGoMethods].sort(),
  );
  const routes = new Set(Object.values(webAuthRoutes));
  for (const route of Object.values(webGoMethodRoutes))
    assert.ok(routes.has(route), route);
});

test("a conversation splits into turn rows and joins back", () => {
  const sample = golden("doc.split");
  const conversation = sample.conversation as Conversation;
  const split = splitConversation(structuredClone(conversation));
  assert.deepEqual(JSON.parse(JSON.stringify(split.doc)), sample.doc);
  assert.deepEqual(JSON.parse(JSON.stringify(split.turns)), sample.turns);
  for (const row of split.turns) parseTurnDoc(JSON.stringify(row));
  parseConversationDoc(JSON.stringify(split.doc));

  const shuffled = [...split.turns].reverse();
  assert.deepEqual(joinConversation(split.doc, shuffled), conversation);

  const noBranches = { ...conversation, savedBranches: undefined };
  delete noBranches.savedBranches;
  const plain = splitConversation(noBranches);
  assert.equal(plain.doc.conversation.savedBranches, undefined);
  assert.deepEqual(joinConversation(plain.doc, plain.turns), noBranches);

  assert.throws(
    () => splitConversation({ ...conversation, incognito: true }),
    WebProtocolError,
  );
  const foreign: TurnDoc = { ...split.turns[0]!, conversationId: "conv-9" };
  assert.throws(() => joinConversation(split.doc, [foreign]), /another/);
  const orphan: TurnDoc = { ...split.turns[0]!, branchId: "branch-gone" };
  assert.throws(() => joinConversation(split.doc, [orphan]), /unknown branch/);
});

test("turn documents are capped at 4 MiB", () => {
  const row = golden("doc.turn.completed");
  row.turn.items[0].summary = ["x".repeat(webLimits.turnDocBytes)];
  assert.throws(() => parseTurnDoc(JSON.stringify(row)), /too large/);
  assert.throws(() => parseTurnDoc(row), /too large/);
  // Multi-byte text counts in UTF-8 bytes.
  row.turn.items[0].summary = ["é".repeat(webLimits.turnDocBytes / 2 - 100)];
  assert.throws(() => parseTurnDoc(JSON.stringify(row)), /too large/);
});
