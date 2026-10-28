import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import {
  directoryConnectors,
  featuredConnectorMembers,
  isApprovedDirectoryEntries,
  type CatalogueConnector,
} from "../../shared/connectors-catalogue";

const entry: ApprovedDirectoryEntry = {
  id: "reviewed-entry",
  kind: "mcp",
  name: "Reference connector",
  description: "Published connector",
  url: "https://reference.example/mcp",
  added: "2026-10-19",
  curation: {
    featured: {
      title: "Reviewed collection",
      subtitle: "Published members",
      curator: "Reference curator",
    },
  },
};
const featured = (memberIds: unknown) => [
  {
    ...entry,
    curation: { featured: { ...entry.curation!.featured!, memberIds } },
  },
];
const record = (
  id: string,
  patch: Partial<CatalogueConnector> = {},
): CatalogueConnector => ({
  id,
  name: id,
  description: "Published record",
  byline: "",
  type: "community",
  topic: "",
  icon: "server",
  ...patch,
});

test("published featured member metadata accepts absence, explicit empty membership and the directory identity bounds", () => {
  assert.equal(isApprovedDirectoryEntries([entry]), true);
  assert.equal(isApprovedDirectoryEntries(featured([])), true);
  assert.equal(isApprovedDirectoryEntries(featured(["x".repeat(256)])), true);
  assert.equal(
    isApprovedDirectoryEntries(
      featured(Array.from({ length: 50 }, (_, index) => `member-${index}`)),
    ),
    true,
  );
});

test("published featured membership rejects malformed, blank, oversized identities and oversized collections", () => {
  for (const memberIds of [
    null,
    "member",
    {},
    [null],
    [1],
    [false],
    [""],
    [" \t\n"],
    ["x".repeat(257)],
    Array.from({ length: 51 }, (_, index) => `member-${index}`),
  ])
    assert.equal(
      isApprovedDirectoryEntries(featured(memberIds)),
      false,
      JSON.stringify(memberIds),
    );
});

test("reviewed membership survives the catalogue merge and resolves both public ids and directory aliases", () => {
  const members = ["service-notion", "member-b", "notion", "service-notion"];
  const approved: ApprovedDirectoryEntry[] = [
    {
      ...entry,
      curation: {
        featured: { ...entry.curation!.featured!, memberIds: members },
      },
    },
    {
      ...entry,
      id: "service-notion",
      name: "Notion",
      url: "https://mcp.notion.com/mcp",
      curation: undefined,
    },
    {
      ...entry,
      id: "member-b",
      name: "Member B",
      url: "https://b.example/mcp",
      curation: undefined,
    },
  ];
  // An approved identity can enrich an existing public id without changing it.
  const records = directoryConnectors(approved);
  const alias = records.find((candidate) => candidate.id === "notion")!;
  assert.equal(alias.directoryId, "service-notion");
  alias.installed = true;
  const bundle = records.find((candidate) => candidate.id === entry.id)!;
  assert.deepEqual(bundle.featured?.memberIds, members);
  assert.deepEqual(
    featuredConnectorMembers(bundle, records).map((member) => member.id),
    ["notion", "member-b"],
  );
  assert.equal(
    featuredConnectorMembers(bundle, records)[0],
    alias,
    "installed public records retain their actual catalogue identity",
  );
});

test("featured resolution preserves declared order and never fabricates unknown ids or private custom entries", () => {
  const a = record("a"),
    b = record("b", { directoryId: "published-b" }),
    privateCustom = record("private", { type: "custom", installed: true }),
    installedRow = record("installed:private-server");
  const bundle = record("bundle", {
    featured: {
      title: "Bundle",
      subtitle: "",
      memberIds: [
        "unknown",
        "private",
        "installed:private-server",
        "published-b",
        "a",
        "b",
        "published-b",
      ],
    },
  });
  const catalogue = [a, privateCustom, installedRow, b, bundle];
  assert.deepEqual(featuredConnectorMembers(bundle, catalogue), [b, a]);
  assert.equal(
    catalogue.length,
    5,
    "resolution leaves the public catalogue untouched",
  );
});

test("featured resolution caps actual resolved members at seven after deduplication and missing ids", () => {
  const records = Array.from({ length: 10 }, (_, index) =>
    record(`member-${index}`),
  );
  const declared = [
    "unknown",
    ...records
      .slice()
      .reverse()
      .flatMap((member) => [member.id, member.id]),
  ];
  const bundle = record("bundle", {
    featured: { title: "Bundle", subtitle: "", memberIds: declared },
  });
  assert.deepEqual(
    featuredConnectorMembers(bundle, records).map((member) => member.id),
    records
      .slice()
      .reverse()
      .slice(0, 7)
      .map((member) => member.id),
  );
});

test("absent membership keeps a genuine single-record fallback while explicit empty membership stays empty", () => {
  const real = record("bundle", {
    directoryId: "service-bundle",
    featured: { title: "Bundle", subtitle: "" },
  });
  assert.deepEqual(featuredConnectorMembers(real, [real]), [real]);
  assert.deepEqual(
    featuredConnectorMembers({ ...real, id: "service-bundle" }, [real]),
    [real],
  );
  assert.deepEqual(
    featuredConnectorMembers(
      { ...real, featured: { ...real.featured!, memberIds: [] } },
      [real],
    ),
    [],
  );
  assert.deepEqual(featuredConnectorMembers(record("unknown"), [real]), []);
  assert.deepEqual(
    featuredConnectorMembers(record("private", { type: "custom" }), [
      record("private", { type: "custom" }),
    ]),
    [],
  );
});
