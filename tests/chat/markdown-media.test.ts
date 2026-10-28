import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadKatex, Markdown } from "../../src/ui/Markdown";
import { normalizeMathDelimiters } from "../../src/ui/markdown-math";
import { externalUrl } from "../../src/ui/ExternalLinks";
import {
  fetchRemoteImage,
  isPrivateAddress,
  maxRemoteImageBytes,
} from "../../electron/workspace/remote-image";

const render = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text, onArtifact() {} }));

test("bracket math delimiters become remark-math dollars outside code", () => {
  assert.equal(normalizeMathDelimiters("a \\(x^2\\) b"), "a $$x^2$$ b");
  assert.equal(
    normalizeMathDelimiters("\\[\n\\sum x\n\\]"),
    "\n$$\n\\sum x\n$$\n",
  );
  const code = "`\\(kept\\)` and\n```\n\\[kept\\]\n```";
  assert.equal(normalizeMathDelimiters(code), code);
  assert.equal(normalizeMathDelimiters("costs $5 and $10"), "costs $5 and $10");
});

test("inline and block math render with KaTeX; single dollars stay text", async () => {
  await loadKatex();
  const html = render("Energy \\(E = mc^2\\).\n\n$$\n\\int_0^1 x\\,dx\n$$");
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.doesNotMatch(render("costs $5 and $10"), /katex/);
});

test("remote images wait for a choice and links go through confirmation", () => {
  const html = render(
    "![Diagram](https://images.example.com/d.png) [site](https://example.com)",
  );
  assert.match(html, /Diagram/);
  assert.match(html, /images\.example\.com/);
  assert.match(html, /Load image/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(render("![x](file:///etc/passwd)"), /Load image/);
  assert.equal(externalUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(externalUrl("javascript:alert(1)"), undefined);
  assert.equal(externalUrl("/relative"), undefined);
});

test("code blocks use English labels", () => {
  const html = render("```js\nlet a = 1;\n```");
  assert.match(html, />Open</);
});

test("remote images load as bounded data URLs of image types only", async () => {
  const respond =
    (body: BodyInit, type: string, status = 200): typeof fetch =>
    async () =>
      new Response(body, { status, headers: { "content-type": type } });
  const publicHost = async () => ["93.184.215.14"];
  const load = (url: string, fetchImpl: typeof fetch) =>
    fetchRemoteImage(url, fetchImpl, publicHost);
  assert.equal(
    await load(
      "https://example.com/a.png",
      respond(new Uint8Array([1, 2, 3]), "image/png"),
    ),
    "data:image/png;base64,AQID",
  );
  await assert.rejects(
    load("https://example.com/a", respond("<html>", "text/html")),
    /not point to an image/,
  );
  await assert.rejects(
    load("https://example.com/a", respond("", "image/png", 404)),
    /HTTP 404/,
  );
  await assert.rejects(
    load(
      "https://example.com/a",
      respond(new Uint8Array(maxRemoteImageBytes + 1), "image/png"),
    ),
    /larger than 10 MB/,
  );
  await assert.rejects(
    load("file:///etc/passwd", respond("", "image/png")),
    /Only HTTP/,
  );
});

test("remote images never reach this computer or the local network", async () => {
  let fetched = 0;
  const image: typeof fetch = async () => {
    fetched++;
    return new Response(new Uint8Array([1]), {
      headers: { "content-type": "image/png" },
    });
  };
  for (const url of [
    "http://127.0.0.1:8080/a.png",
    "http://[::1]/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.1/a.png",
    "http://[::ffff:10.0.0.1]/a.png",
  ])
    await assert.rejects(
      fetchRemoteImage(url, image, async () => []),
      /local network/,
    );
  // A public name that resolves to a private address is refused too.
  await assert.rejects(
    fetchRemoteImage("https://rebind.example/a.png", image, async () => [
      "10.1.2.3",
    ]),
    /local network/,
  );
  assert.equal(fetched, 0);
  // Redirects are followed by hand, so each hop is checked again.
  const hops: string[] = [];
  const redirecting: typeof fetch = async (input) => {
    hops.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { location: "http://localhost/secret.png" },
    });
  };
  await assert.rejects(
    fetchRemoteImage("https://example.com/a.png", redirecting, async (host) =>
      host === "localhost" ? ["127.0.0.1"] : ["93.184.215.14"],
    ),
    /local network/,
  );
  assert.deepEqual(hops, ["https://example.com/a.png"]);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700::1111"), false);
});
