import assert from "node:assert/strict";
import test from "node:test";
import type { PluginEntry } from "../../shared/collections-api";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import { pluginCuration } from "../../src/plugins/plugin-curation";

const plugin = (name: string, marketplace = "market"): PluginEntry => ({
  id: `${name}@${marketplace}`,
  name,
  title: name,
  marketplace,
  marketplacePath: `/m/${marketplace}`,
  installed: false,
  enabled: false,
  installable: true,
  source: "git",
});
const entry = (
  id: string,
  slug: string | undefined,
  curation: ApprovedDirectoryEntry["curation"],
  added = "2026-10-01T00:00:00Z",
  kind: "plugin" | "mcp" = "plugin",
): ApprovedDirectoryEntry => ({
  id,
  kind,
  name: slug ?? id,
  slug,
  description: "",
  url: "https://example.com",
  added,
  curation,
});

test("curated blocks name real marketplace plugins; nothing else appears", () => {
  const plugins = [plugin("data"), plugin("docs"), plugin("lint")];
  const curation = pluginCuration(plugins, [
    entry("a", "docs", { isNew: true }, "2026-10-02T00:00:00Z"),
    entry("b", "lint", { isNew: true, popular: true }, "2026-10-05T00:00:00Z"),
    entry("c", "missing", { isNew: true, popular: true }),
    entry("d", "data", { popular: true }, undefined, "mcp"),
  ]);
  assert.deepEqual(
    curation.newest.map((item) => item.id),
    ["lint@market", "docs@market"],
  );
  assert.deepEqual(
    curation.popular.map((item) => item.id),
    ["lint@market"],
  );
  assert.equal(curation.featured, undefined);
});

test("a featured block resolves directory members, plugin ids and unique names", () => {
  const plugins = [plugin("data"), plugin("docs"), plugin("lint")];
  const curation = pluginCuration(plugins, [
    entry("member", "docs", undefined),
    entry("hero", "data", {
      featured: {
        title: "Data",
        subtitle: "Analyse data",
        memberIds: ["member", "lint@market", "data", "nope"],
      },
    }),
  ]);
  assert.equal(curation.featured?.title, "Data");
  assert.deepEqual(
    curation.featured?.plugins.map((item) => item.id),
    ["docs@market", "lint@market", "data@market"],
  );
});

test("a name two marketplaces share is not guessed; without members the entry's own plugin is featured", () => {
  const plugins = [plugin("data", "one"), plugin("data", "two"), plugin("x")];
  const curation = pluginCuration(plugins, [
    entry("a", "data", { isNew: true }),
    entry("b", "x", { featured: { title: "X", subtitle: "" } }),
  ]);
  assert.deepEqual(curation.newest, []);
  assert.deepEqual(
    curation.featured?.plugins.map((item) => item.id),
    ["x@market"],
  );
  assert.deepEqual(pluginCuration(plugins, undefined).popular, []);
});
