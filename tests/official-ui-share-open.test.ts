import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { openOfficialShareLink } from "../electron/official-ui/open-share-link";
import { cookieName } from "../electron/official-ui/server";

test("original desktop share popups open only confirmed links for the current account", async (t) => {
  const lookedUp: string[] = [];
  const opened: string[] = [];
  let active = true;
  let delayed: http.ServerResponse | undefined;
  let requested = () => {};
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, `${cookieName}=fixture`);
    assert.equal(req.method, "GET");
    assert.match(req.url ?? "", /^\/api\/__claudex\/share-url\//);
    lookedUp.push(req.url!);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (req.url?.endsWith("/retired")) {
      delayed = res;
      requested();
    } else if (req.url?.endsWith("/missing")) {
      res.writeHead(404).end();
    } else if (req.url?.endsWith("/private")) {
      res.end("https://shares.example.test/shared/invited");
    } else {
      res.end("https://shares.example.test/s/public");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const listening = server.address();
  assert.ok(listening && typeof listening === "object");
  const origin = `http://127.0.0.1:${listening.port}`;
  const open = (address: string) =>
    openOfficialShareLink({
      target: new URL(address, origin),
      origin,
      token: "fixture",
      current: () => active,
      open: async (destination) => {
        opened.push(destination);
      },
    });

  await open("/share/public");
  await open("/share/private?open_in_browser=1");
  await open("/share/missing");
  assert.equal(open("/share/public?any=1"), undefined);
  assert.equal(open("https://elsewhere.example.test/share/public"), undefined);
  assert.equal(open("/chat/public"), undefined);

  const ready = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const opening = open("/share/retired");
  await ready;
  active = false;
  delayed!.end("https://shares.example.test/s/retired");
  await opening;
  assert.deepEqual(
    lookedUp,
    ["public", "private", "missing", "retired"].map(
      (id) => "/api/__claudex/share-url/" + id,
    ),
  );
  assert.deepEqual(opened, [
    "https://shares.example.test/s/public",
    "https://shares.example.test/shared/invited",
  ]);
});
