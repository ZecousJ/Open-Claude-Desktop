import test from "node:test";
import assert from "node:assert/strict";
import {
  popoutChrome,
  popoutChromeCsp,
  popoutCommand,
  popoutLink,
} from "../../electron/artifacts/artifact-popout-page";
import {
  ArtifactPreviews,
  previewCsp,
} from "../../electron/artifacts/artifact-previews";

const base = "claudex-preview://document/0b0c7b1e-3f7a-4d7e-9a3d-1c2b3a4d5e6f";

test("only the toolbar's fixed commands are read from its fragment", () => {
  assert.equal(popoutCommand(`${base}#cmd=pin-on&n=1`), "pin-on");
  assert.equal(popoutCommand(`${base}#cmd=download&n=12`), "download");
  for (const url of [
    `${base}#cmd=quit&n=1`,
    `${base}#cmd=download`,
    `${base}#cmd=download&n=1&x=2`,
    `${base}#cmd=Download&n=1`,
    `${base}`,
    "not a url",
  ])
    assert.equal(popoutCommand(url), undefined, url);
});

test("the toolbar page escapes the title and keeps the artifact sandboxed", () => {
  const html = popoutChrome({
    title: `<img src=x onerror="alert(1)">`,
    frameUrl: base,
    dark: true,
    platform: "win32",
    canSave: false,
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(
    html,
    /<iframe [^>]*sandbox="allow-scripts" src="claudex-preview:/,
  );
  assert.doesNotMatch(html, /allow-same-origin|allow-top-navigation/);
  // Without the artifact's text there is nothing to save or copy.
  assert.doesNotMatch(html, /data-cmd="download"|data-cmd="copy"/);
  assert.match(
    popoutChrome({
      title: "Card",
      frameUrl: base,
      dark: false,
      platform: "darwin",
      canSave: true,
    }),
    /data-cmd="download"[^]*data-cmd="copy"/,
  );
});

test("the toolbar has the original's Chat, comment pair and Share (R-0916); only Chat acts", () => {
  const html = popoutChrome({
    title: "Card",
    frameUrl: base,
    dark: true,
    platform: "win32",
    canSave: true,
  });
  // Chat returns to the main window; comments and Share are greyed with a reason.
  assert.match(
    html,
    /<button class="chat" data-cmd="return"[^>]*>[^]*Chat<\/button>/,
  );
  assert.match(html, /<button disabled aria-label="Comment" title="[^"]+">/);
  assert.match(
    html,
    /<button disabled aria-label="More comment options" title="[^"]+">/,
  );
  assert.match(
    html,
    /<button class="share" disabled title="[^"]+">[^]*Share<\/button>/,
  );
  // Order at the right of the bar: Chat, comments, Share, return, keep on top.
  const order = [
    'class="chat"',
    'class="comments"',
    'class="share"',
    'aria-label="Return to the main window"',
    "data-pin",
  ].map((part) => html.indexOf(part));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
});

test("a pop-out's toolbar page gets its own policy; artifacts keep the preview one", async () => {
  const previews = new ArtifactPreviews();
  const artifact = previews.create("<p>artifact</p>");
  const chrome = previews.create("<p>toolbar</p>", { csp: popoutChromeCsp });
  assert.equal(
    previews.response(artifact).headers.get("content-security-policy"),
    previewCsp,
  );
  const policy = previews
    .response(chrome)
    .headers.get("content-security-policy")!;
  assert.match(policy, /frame-src claudex-preview:/);
  assert.match(policy, /connect-src 'none'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.match(previewCsp, /sandbox allow-scripts/);
  assert.match(previewCsp, /connect-src 'none'/);
  assert.doesNotMatch(previewCsp, /unsafe-eval|allow-same-origin/);
  assert.equal(await previews.response(chrome).text(), "<p>toolbar</p>");
});

test("only web addresses in a pop-out are passed on to be confirmed", () => {
  assert.equal(
    popoutLink("https://example.com/a?b=1"),
    "https://example.com/a?b=1",
  );
  assert.equal(popoutLink("HTTP://example.com"), "HTTP://example.com");
  for (const url of [
    "mailto:a@b.c",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "claudex-preview://document/x",
    "not a url",
    "",
  ])
    assert.equal(popoutLink(url), undefined, url);
});
