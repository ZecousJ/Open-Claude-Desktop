import test from "node:test";
import assert from "node:assert/strict";
import {
  customizePath,
  parseCustomizePath,
  type CustomizePlace,
} from "../../src/web/customize-route";
import {
  formatWebRoute,
  parseWebRoute,
  urlForState,
} from "../../src/web/routes";
import { historyStep } from "../../src/web/web-route-apply";

for (const section of ["skills", "connectors", "plugins"] as const) {
  for (const view of ["yours", "discover"] as const) {
    test(`Customize ${section}/${view} keeps its list and detail addresses`, () => {
      for (const detailId of [undefined, "real-id", "技能 1"]) {
        const place: CustomizePlace = {
          section,
          view,
          ...(detailId === undefined ? {} : { detailId }),
        };
        const url = customizePath(place);
        assert.deepEqual(parseCustomizePath(url), place);
        const route = {
          kind: "page" as const,
          page: "customize" as const,
          customize: place,
        };
        assert.deepEqual(parseWebRoute(url), route);
        assert.equal(formatWebRoute(route), url);
        assert.equal(
          urlForState({
            page: "customize",
            mode: "chat",
            customizePlace: place,
          }),
          url,
        );
        const settings = parseWebRoute(url, "", "#settings/data-privacy-controls");
        assert.deepEqual(settings, {
          kind: "settings",
          tab: "privacy",
          background: route,
        });
        assert.equal(formatWebRoute(settings), `${url}#settings/data-privacy-controls`);
      }
    });
  }
}

test("Customize rejects malformed identifiers, unknown sections and extra segments", () => {
  for (const suffix of [
    "skills/id/%",
    "skills/id/%2Fprivate",
    "skills/id/%5Cprivate",
    "skills/id/%00",
    "skills/id/one/two",
    "not-a-section",
    "skills/id/",
    "skills/unknown",
  ]) {
    assert.equal(parseCustomizePath(`/customize/${suffix}`), undefined, suffix);
    assert.equal(
      parseWebRoute(`/customize/${suffix}`).kind,
      "not-found",
      suffix,
    );
  }
  assert.equal(
    formatWebRoute(parseWebRoute("/customize/skills/discover")),
    "/customize/skills",
  );
  assert.equal(formatWebRoute(parseWebRoute("/customize")), "/customize");
});

test("a late Customize list target preserves the concrete detail selected by its page", () => {
  assert.equal(
    historyStep({
      previous: { url: "/new", settingsOpen: false },
      next: { url: "/customize", settingsOpen: false },
      address: "/customize/connectors/id/notion",
      openedSettings: false,
      draftKnown: null,
    }),
    "none",
  );
  assert.equal(
    historyStep({
      previous: { url: "/new", settingsOpen: false },
      next: { url: "/recents", settingsOpen: false },
      address: "/customize/connectors/id/notion",
      openedSettings: false,
      draftKnown: null,
    }),
    "push",
  );
});

test("installed skill Contents round-trips through the web route and preserves settings history", () => {
  const place: CustomizePlace = {
    section: "skills",
    view: "yours",
    detailId: "技能 {project}",
    detailView: "contents",
  };
  const path = customizePath(place);
  assert.equal(
    path,
    "/customize/skills/yours/id/%E6%8A%80%E8%83%BD%20%7Bproject%7D/contents",
  );
  assert.deepEqual(parseCustomizePath(path), place);
  assert.deepEqual(parseWebRoute(path), {
    kind: "page",
    page: "customize",
    customize: place,
  });
  assert.equal(
    formatWebRoute({ kind: "page", page: "customize", customize: place }),
    path,
  );
  assert.equal(
    urlForState({ page: "customize", mode: "chat", customizePlace: place }),
    path,
  );
  assert.deepEqual(
    parseCustomizePath(customizePath({ ...place, detailView: "overview" })),
    { section: "skills", view: "yours", detailId: "技能 {project}" },
  );
});

test("Contents requires an installed skill identity and cannot become a connector or plugin route", () => {
  for (const path of [
    "/customize/skills/contents",
    "/customize/skills/yours/contents",
    "/customize/skills/id/a/contents",
    "/customize/skills/discover/id/a/contents",
    "/customize/connectors/yours/id/a/contents",
    "/customize/plugins/yours/id/a/contents",
    "/customize/skills/yours/id/%2f/contents",
    "/customize/skills/yours/id/%00/contents",
    "/customize/skills/yours/id/%/contents",
    "/customize/skills/yours/id/a/contents/extra",
  ]) {
    assert.equal(parseCustomizePath(path), undefined, path);
  }
});
