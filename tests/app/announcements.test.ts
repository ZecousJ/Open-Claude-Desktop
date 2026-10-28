import test from "node:test";
import assert from "node:assert/strict";
import { announcementsFrom } from "../../shared/announcements-api";
import { announcementDocument } from "../../src/announcements/announcementDocument";
import { createAnnouncementMethods } from "../../src-web/bridge/announcements";

const item = (extra: Record<string, unknown> = {}) => ({
  id: 3,
  title: "Hello",
  badge: "New",
  body_html: "<p>Hi</p>",
  image_url: "https://example.com/a.png",
  primary_label: "Go",
  primary_url: "https://example.com/go",
  dismiss_label: "",
  ...extra,
});

test("the service's announcements are read field by field", () => {
  const [one] = announcementsFrom([item()]);
  assert.deepEqual(one, {
    id: 3,
    badge: "New",
    title: "Hello",
    bodyHtml: "<p>Hi</p>",
    bodyFormat: "text",
    imageUrl: "https://example.com/a.png",
    primaryLabel: "Go",
    primaryUrl: "https://example.com/go",
    dismissLabel: "",
  });
  assert.equal(
    announcementsFrom([item({ body_format: "html" })])[0]?.bodyFormat,
    "html",
  );
  // Anything that isn't an http(s) address is dropped, so a button or a
  // picture can never point at javascript: or data: addresses.
  const [bad] = announcementsFrom([
    item({ image_url: "javascript:alert(1)", primary_url: "data:text/html,x" }),
  ]);
  assert.equal(bad?.imageUrl, "");
  assert.equal(bad?.primaryUrl, "");
  // Malformed entries and empty ones are left out.
  assert.deepEqual(
    announcementsFrom([
      null,
      5,
      item({ id: 0 }),
      item({ id: "7" }),
      item({ title: "", body_html: " " }),
    ]),
    [],
  );
  assert.deepEqual(announcementsFrom({ items: [] }), []);
  assert.equal(announcementsFrom(new Array(50).fill(item())).length, 20);
});

test("the body is drawn in a document that starts from the app's ink and lets the HTML override it", () => {
  const light = announcementDocument(
    "<p>x</p><style>p{color:red}</style>",
    false,
  );
  assert.match(light, /color-scheme" content="light"/);
  assert.match(light, /color:#0b0b0b/);
  assert.ok(light.indexOf("color:#0b0b0b") < light.indexOf("p{color:red}"));
  const dark = announcementDocument("<p>x</p>", true);
  assert.match(dark, /color-scheme" content="dark"/);
  assert.match(dark, /color:#f0efec/);
});

test("the web bridge asks for pending announcements and reports a close", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const methods = createAnnouncementMethods({
    json: async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      return path.endsWith("/pending")
        ? { code: 0, data: { items: [item()] } }
        : { code: 0, data: { recorded: true } };
    },
  } as never);
  const pending = (await methods.pendingAnnouncements()) as { id: number }[];
  assert.deepEqual(
    pending.map((entry) => entry.id),
    [3],
  );
  await methods.closeAnnouncement(3, "primary");
  assert.equal(calls[0]?.[0], "/api/v1/claudex/announcements/pending");
  assert.equal(calls[1]?.[0], "/api/v1/claudex/announcements/3/read");
  assert.equal(calls[1]?.[1]?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1]?.[1]?.body)), {
    action: "primary",
  });
  // A service that can't answer shows none.
  const broken = createAnnouncementMethods({
    json: async () => {
      throw new Error("offline");
    },
  } as never);
  assert.deepEqual(await broken.pendingAnnouncements(), []);
});
