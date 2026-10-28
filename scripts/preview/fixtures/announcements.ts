/**
 * Announcements: `announce=image` one with a picture, `announce=plain` one
 * without, `announce=two` two in a row. Closing one records it, so the next
 * shows (and a reload of the fixture starts over).
 */
import type { Announcement } from "../../../shared/announcements-api";
import type { FixtureDomain } from "./index";

const picture =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700"><rect width="600" height="700" fill="#d9c6a5"/><path d="M0 470 L250 420 L600 470 V700 H0Z" fill="#d79b2c"/></svg>`,
  );

const body = `<style>li{list-style:none;margin:0 0 18px;padding-left:0} .row{display:flex;gap:14px;align-items:flex-start}</style>
<div class="row"><span>💬</span><span>Catch up on long tasks with clear summaries</span></div><br>
<div class="row"><span>📄</span><span>Make documents and spreadsheets that need less editing</span></div><br>
<div class="row"><span>💧</span><span>Get extra wiggle room to explore with a limit reset (expires Oct 22)</span></div>`;

const first: Announcement = {
  id: 1,
  badge: "New",
  title: "Get to finished work sooner with Opus 5.5",
  bodyHtml: body,
  bodyFormat: "html",
  imageUrl: "",
  primaryLabel: "Try Opus 5.5",
  primaryUrl: "https://example.com/opus",
  dismissLabel: "Not now",
};
const second: Announcement = {
  id: 2,
  badge: "",
  title: "Maintenance tonight",
  bodyHtml:
    "The service restarts at 02:00 for about a minute.\nNothing you have open is lost.",
  bodyFormat: "text",
  imageUrl: "",
  primaryLabel: "",
  primaryUrl: "",
  dismissLabel: "",
};

export const announcementsFixture: FixtureDomain = {
  params: {
    announce:
      "image | plain | two: pop-ups the administrator published (none by default)",
  },
  bridge: ({ params }) => {
    const mode = params.get("announce");
    if (!mode) return {};
    const closed = new Set<number>();
    const all =
      mode === "image"
        ? [{ ...first, imageUrl: picture }]
        : mode === "two"
          ? [first, second]
          : [first];
    return {
      pendingAnnouncements: async () =>
        all.filter((item) => !closed.has(item.id)),
      closeAnnouncement: async (id: number) => {
        closed.add(id);
      },
    };
  },
};
