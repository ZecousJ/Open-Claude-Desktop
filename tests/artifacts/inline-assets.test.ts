import assert from "node:assert/strict";
import test from "node:test";
import { inlineLocalAssets, siblingPath } from "../../shared/inline-assets";

test("sibling paths resolve from the page's folder and leave web addresses alone", () => {
  assert.equal(
    siblingPath("/w/s/index.html", "css/style.css"),
    "/w/s/css/style.css",
  );
  assert.equal(siblingPath("/w/s/index.html", "./game.js?v=2"), "/w/s/game.js");
  assert.equal(siblingPath("/w/s/a/index.html", "../x.js"), "/w/s/x.js");
  assert.equal(
    siblingPath("C:\\w\\s\\index.html", "js\\game.js"),
    "C:\\w\\s\\js\\game.js",
  );
  assert.equal(siblingPath("/w/index.html", "https://cdn/x.js"), undefined);
  assert.equal(siblingPath("/w/index.html", "//cdn/x.js"), undefined);
  assert.equal(siblingPath("/w/index.html", "/x.js"), undefined);
});

test("a page's own stylesheets and scripts made beside it run inline", () => {
  const files = new Map([
    ["/w/s/css/style.css", "body{color:red}"],
    ["/w/s/js/game.js", "if (a) document.write('</script>');"],
  ]);
  const html = [
    '<link rel="stylesheet" href="css/style.css">',
    '<link rel="icon" href="favicon.ico">',
    '<script type="module" src="js/game.js"></script>',
    '<script src="https://cdn.example/lib.js"></script>',
    '<script src="missing.js"></script>',
  ].join("\n");
  const out = inlineLocalAssets(html, "/w/s/index.html", (p) => files.get(p));
  assert.match(out, /<style>body\{color:red\}<\/style>/);
  assert.match(out, /<link rel="icon" href="favicon.ico">/);
  assert.match(
    out,
    /<script type="module">if \(a\) document\.write\('<\\\/script>'\);<\/script>/,
  );
  assert.match(out, /<script src="https:\/\/cdn\.example\/lib\.js"><\/script>/);
  assert.match(out, /<script src="missing\.js"><\/script>/);
});

test("a deferred script runs after the page it reads, as defer would", () => {
  const files = new Map([
    ["/w/a.js", "A()"],
    ["/w/b.js", "B()"],
    ["/w/m.js", "M()"],
  ]);
  const html =
    '<html><head><script src="a.js" defer></script><script src="b.js" async></script><script type="module" src="m.js"></script></head><body><input id="speed"></body></html>';
  const out = inlineLocalAssets(html, "/w/index.html", (p) => files.get(p));
  assert.equal(
    out,
    '<html><head><script type="module">M()</script></head><body><input id="speed"><script>A()</script><script>B()</script></body></html>',
  );
});
