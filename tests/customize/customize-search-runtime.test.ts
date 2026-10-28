import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CustomizeSearchService,
  customizeSearchQuery,
  customizeSkillSearchHits,
  customizePluginSearchHits,
  customizeConnectorSearchHits,
  customizeDirectorySearchHits,
} from "../../electron/plugins/customize-search";
import {
  validCustomizeSearchResult,
  type CustomizeSearchHit,
  type CustomizeSearchRequest,
} from "../../shared/customize-search";
import { customizeSkills } from "../../electron/ipc/collections";
import { pluginCatalog } from "../../electron/plugins/plugin-catalog";

const hit = (
  id: string,
  kind: CustomizeSearchHit["kind"] = "skill",
  yours = true,
  name = `Alpha ${id}`,
): CustomizeSearchHit => ({
  key: `${kind}:${id}`,
  kind,
  yours,
  name,
  description: "Description only zebra",
  target:
    kind === "skill"
      ? { type: "skill", path: `/skills/${id}/SKILL.md` }
      : { type: kind, id },
});
const request = (
  patch: Partial<CustomizeSearchRequest> = {},
): CustomizeSearchRequest => ({
  query: "Alpha",
  page: "skills",
  section: "yours",
  ...patch,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const code = (name: string) => ({ code: `CLAUDEX_CUSTOMIZE_SEARCH_${name}` });

test("3/4: queries use two Unicode letters/digits and a 200-code-point cutoff; ineligible queries do not touch providers", async () => {
  let reads = 0;
  const owner = {};
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => {
      reads++;
      return [hit("a")];
    },
  });
  for (const query of ["", " ", "a", "a😀", "🙂🙂", "─1─"])
    assert.deepEqual(await service.search(request({ query })), {
      items: [],
      total: 0,
    });
  assert.equal(reads, 0);
  assert.equal(customizeSearchQuery("  中Ａ  "), "中Ａ");
  assert.equal(customizeSearchQuery("𐐀１"), "𐐀１");
  assert.equal(Array.from(customizeSearchQuery("𐐀".repeat(201))).length, 200);
  assert.equal(customizeSearchQuery("a".repeat(201)), "a".repeat(200));
  assert.equal(
    customizeSearchQuery("😀".repeat(200) + "ab"),
    "😀".repeat(200),
    "source eligibility precedes the server cutoff",
  );
});

test("3/15: name-only fuzzy search intersects words at .25 and preserves actual catalogue order", async () => {
  const owner = {},
    records = [
      hit("first", "skill", true, "Beta Alpha"),
      hit("second", "skill", true, "Alpha Beta"),
      hit("third", "skill", true, "Alpha"),
      hit("fourth", "skill", true, "Unrelated"),
    ];
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => records,
  });
  assert.deepEqual(
    (await service.search(request({ query: "alpha beta" }))).items.map(
      (item) => item.key,
    ),
    ["skill:first", "skill:second"],
  );
  assert.deepEqual(
    (await service.search(request({ query: "ALPHX" }))).items.map(
      (item) => item.key,
    ),
    ["skill:first", "skill:second", "skill:third"],
  );
  assert.equal(
    (await service.search(request({ query: "zebra" }))).total,
    0,
    "description never supplies a name match",
  );
  assert.equal((await service.search(request({ query: "alxxa" }))).total, 0);
});

test("3/4: sections are disjoint; cross-kind ownership stays in More instead of leaking into Yours", async () => {
  const owner = {},
    records = [
      hit("own"),
      hit("catalogue", "skill", false),
      hit("installed", "plugin", true),
      hit("plugin", "plugin", false),
      hit("connected", "connector", true),
    ];
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => records,
  });
  assert.deepEqual(
    (await service.search(request())).items.map((item) => item.key),
    ["skill:own"],
  );
  assert.deepEqual(
    (await service.search(request({ section: "inPage" }))).items.map(
      (item) => item.key,
    ),
    ["skill:catalogue"],
  );
  assert.deepEqual(
    (await service.search(request({ section: "more" }))).items.map(
      (item) => item.key,
    ),
    ["plugin:installed", "plugin:plugin", "connector:connected"],
  );
  assert.deepEqual(
    (await service.search(request({ page: "plugins" }))).items.map(
      (item) => item.key,
    ),
    ["plugin:installed"],
  );
});

test("4: next-page calls consume an immutable host snapshot, default to five, and expose no renderer-owned reveal counter", async () => {
  const owner = {};
  let records = Array.from({ length: 13 }, (_, index) => hit(String(index))),
    reads = 0;
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => {
      reads++;
      return records;
    },
  });
  const first = await service.customizeSearch(request());
  assert.equal(first.items.length, 5);
  assert.equal(first.total, 13);
  assert.ok(first.nextCursor && first.nextCursor.length <= 4096);
  assert.ok(validCustomizeSearchResult(first));
  first.items[0].name = "Caller mutation";
  records = [hit("replacement")];
  const second = await service.customizeSearch(
    request({ cursor: first.nextCursor }),
  );
  assert.deepEqual(
    second.items.map((item) => item.key),
    ["skill:5", "skill:6", "skill:7", "skill:8", "skill:9"],
  );
  assert.equal(second.total, 13);
  assert.equal(reads, 1);
  const final = await service.search(request({ cursor: second.nextCursor }));
  assert.deepEqual(
    final.items.map((item) => item.key),
    ["skill:10", "skill:11", "skill:12"],
  );
  assert.equal(final.nextCursor, undefined);
  assert.deepEqual(
    (await service.search(request({ cursor: first.nextCursor }))).items,
    second.items,
    "continuation replay remains stable",
  );
  assert.equal(
    (await service.search(request())).total,
    1,
    "a new search reads actual current data",
  );
});

test("4: response rows are capped at 100; a changed page size continues without skipping items", async () => {
  const owner = {};
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () =>
      Array.from({ length: 205 }, (_, index) => hit(String(index))),
  });
  const first = await service.search(request({ limit: 100 }));
  assert.equal(first.items.length, 100);
  assert.equal(first.total, 205);
  assert.ok(Number.isSafeInteger(first.total));
  const second = await service.search(
    request({ cursor: first.nextCursor, limit: 1 }),
  );
  assert.equal(second.items[0].key, "skill:100");
  await assert.rejects(
    service.search(request({ limit: 101 })),
    code("INVALID_REQUEST"),
  );
});

test("3/4: malformed, tampered, foreign-service, query, page, section and owner cursors fail explicitly", async () => {
  let owner = {};
  const records = Array.from({ length: 7 }, (_, index) => hit(String(index)));
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => records,
  });
  const first = await service.search(request());
  for (const cursor of [
    "",
    "offset=5",
    "x".repeat(4097),
    first.nextCursor!.slice(0, -1) + "!",
    "😀",
  ])
    await assert.rejects(
      service.search(request({ cursor })),
      code("INVALID_CURSOR"),
    );
  for (const patch of [
    { query: "Beta" },
    { page: "plugins" as const },
    { section: "more" as const },
  ])
    await assert.rejects(
      service.search(request({ ...patch, cursor: first.nextCursor })),
      code("INVALID_CURSOR"),
    );
  const other = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => records,
  });
  await assert.rejects(
    other.search(request({ cursor: first.nextCursor })),
    code("INVALID_CURSOR"),
  );
  owner = {};
  await assert.rejects(
    service.search(request({ cursor: first.nextCursor })),
    code("INVALID_CURSOR"),
  );
});

test("4: cursors expire by their original TTL and bounded cache eviction is an explicit error", async () => {
  let now = 100;
  const owner = {},
    records = Array.from({ length: 7 }, (_, index) => hit(String(index)));
  const service = new CustomizeSearchService(
    { owner: () => owner, readHits: () => records, now: () => now },
    { ttlMs: 20, maxSnapshots: 1 },
  );
  const first = await service.search(request());
  now = 110;
  await service.search(request({ cursor: first.nextCursor }));
  now = 120;
  await assert.rejects(
    service.search(request({ cursor: first.nextCursor })),
    code("CURSOR_EXPIRED"),
  );
  const next = await service.search(request());
  await service.search(request({ section: "more" }));
  await assert.rejects(
    service.search(request({ cursor: next.nextCursor })),
    code("INVALID_CURSOR"),
  );
});

test("3/15: old-owner late catalogue reads reject while a replacement owner can read its own data", async () => {
  const old = deferred<CustomizeSearchHit[]>();
  let owner = {},
    calls = 0;
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => (++calls === 1 ? old.promise : [hit("new-owner")]),
  });
  const pending = service.search(request());
  await Promise.resolve();
  owner = {};
  const current = await service.search(request());
  old.resolve([hit("old-owner")]);
  await assert.rejects(pending, code("OWNER_CHANGED"));
  assert.deepEqual(
    current.items.map((item) => item.key),
    ["skill:new-owner"],
  );
});

test("3/4: pending reads are coalesced for concurrent sections, without mixing ownership or swallowing provider errors", async () => {
  const owner = {},
    read = deferred<CustomizeSearchHit[]>();
  let calls = 0;
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => {
      calls++;
      return read.promise;
    },
  });
  const requests = [
    service.search(request()),
    service.search(request({ section: "inPage" })),
    service.search(request({ section: "more" })),
  ];
  await Promise.resolve();
  assert.equal(calls, 1);
  read.resolve([hit("one")]);
  await Promise.all(requests);
  const failure = Error("Actual catalogue reader failed");
  const failed = new CustomizeSearchService({
    owner: () => owner,
    readHits: async () => {
      throw failure;
    },
  });
  await assert.rejects(failed.search(request()), (error) => error === failure);
});

test("3/15: navigation targets are fenced, extra backend fields are projected away and source keys deduplicate stably", async () => {
  const owner = {},
    original = hit("one");
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => [
      {
        ...original,
        secret: "private",
        target: { ...original.target, token: "private" },
      } as unknown as CustomizeSearchHit,
      original,
    ],
  });
  const result = await service.search(request());
  assert.equal(result.total, 1);
  assert.equal("secret" in result.items[0], false);
  assert.equal("token" in result.items[0].target, false);
  for (const target of [
    { type: "external", url: "http://example.com" },
    { type: "external", url: "https://user:secret@example.com" },
    { type: "external", url: "javascript:alert(1)" },
    { type: "plugin", id: "wrong-kind" },
  ]) {
    const invalid = new CustomizeSearchService({
      owner: () => owner,
      readHits: () => [{ ...original, target } as CustomizeSearchHit],
    });
    await assert.rejects(invalid.search(request()), code("INVALID_CATALOGUE"));
  }
});

test("4: catalogue/snapshot bounds are enforced without inventing a smaller successful total", async () => {
  const owner = {};
  const tooMany = new CustomizeSearchService(
    { owner: () => owner, readHits: () => [hit("one"), hit("two")] },
    { maxCatalogueHits: 1 },
  );
  await assert.rejects(tooMany.search(request()), code("CATALOGUE_LIMIT"));
  const tooLarge = new CustomizeSearchService(
    { owner: () => owner, readHits: () => [hit("one")] },
    { maxSnapshotBytes: 1 },
  );
  await assert.rejects(tooLarge.search(request()), code("CATALOGUE_LIMIT"));
});

test("3/15: actual skill/plugin catalogue readers and indexed connector/directory adapters supply typed host results", async (context) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "customize-b32-search-")),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownPath = path.join(root, "codex-home", "skills", "alpha", "SKILL.md"),
    systemPath = path.join(root, "bundled", "SKILL.md");
  for (const file of [ownPath, systemPath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# Alpha skill\nActual indexed file");
  }
  const skills = await customizeSkills({
    store: { root },
    engine: {
      rpc: {
        call: async () => ({
          data: [
            {
              skills: [
                {
                  name: "Alpha personal",
                  description: "Own",
                  path: ownPath,
                  scope: "user",
                },
                {
                  name: "Alpha bundled",
                  description: "Bundled",
                  path: systemPath,
                  scope: "system",
                },
              ],
            },
          ],
        }),
      },
    },
  } as never);
  const plugins = pluginCatalog({
    marketplaces: [
      {
        name: "actual-marketplace",
        path: path.join(root, "marketplace.json"),
        plugins: [
          {
            id: "alpha@actual-marketplace",
            name: "alpha",
            interface: { displayName: "Alpha installed plugin" },
            installed: true,
            enabled: false,
            source: { type: "local" },
          },
        ],
      },
    ],
  });
  const owner = {};
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => [
      ...customizeSkillSearchHits(skills),
      ...customizePluginSearchHits(plugins),
      ...customizeConnectorSearchHits([
        { id: "actual-mcp-index", name: "Alpha connector", connected: true },
      ]),
      ...customizeDirectorySearchHits([
        {
          id: "approved",
          kind: "plugin",
          name: "Alpha approved plugin",
          description: "Reviewed",
          url: "https://example.com/approved",
          added: "2026-10-19",
        },
      ]),
    ],
  });
  const yours = await service.search(request());
  assert.deepEqual(
    yours.items.map((item) => item.target),
    [{ type: "skill", path: ownPath }],
  );
  assert.equal(
    (await service.search(request({ section: "inPage" }))).items[0].name,
    "Alpha bundled",
  );
  const more = await service.search(request({ section: "more" }));
  assert.equal(more.total, 3);
  assert.ok(more.items.some((item) => item.kind === "connector" && item.yours));
  assert.ok(validCustomizeSearchResult(more));
  assert.throws(
    () =>
      customizePluginSearchHits({
        ...plugins,
        loadErrors: ["Marketplace read failed"],
      }),
    code("CATALOGUE_UNAVAILABLE"),
  );
});

test("3/15: a late read cannot reenter after an observed account lease cycle, even when the original object is reused", async () => {
  const original = {},
    replacement = {},
    delayed = deferred<CustomizeSearchHit[]>();
  let owner = original,
    reads = 0;
  const service = new CustomizeSearchService({
    owner: () => owner,
    readHits: () => (++reads === 1 ? delayed.promise : [hit(`lease-${reads}`)]),
  });
  const previous = service.search(request());
  await Promise.resolve();
  owner = replacement;
  await service.search(request());
  owner = original;
  const current = await service.search(request());
  delayed.resolve([hit("stale-first-lease")]);
  await assert.rejects(previous, code("OWNER_CHANGED"));
  assert.equal(current.items[0].key, "skill:lease-3");
});
