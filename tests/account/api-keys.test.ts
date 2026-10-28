import test from "node:test";
import assert from "node:assert/strict";
import {
  apiKeyNameProblem,
  apiKeysFrom,
  isDeviceKey,
  maskedKey,
  withKeyCosts,
} from "../../shared/api-keys-api";
import {
  apiGroupsFor,
  catalogInGroup,
  activeGroupIds,
  activeGroups,
  type ServiceGroup,
} from "../../electron/account/api-groups";
import { mergeGroupModels } from "../../shared/provider-routes";
import type { ModelCatalog } from "../../shared/model-catalog-api";

const groups: ServiceGroup[] = [
  {
    id: 2,
    name: "codex",
    primary: true,
    protocol: "responses",
    platform: "openai",
  },
  { id: 3, name: "grok", primary: false, protocol: "chat", platform: "grok" },
];
/** OpenAI has a second group, and every group's own model list is known. */
const several: ServiceGroup[] = [
  {
    ...groups[0]!,
    models: ["gpt-5", "gpt-5-mini"],
  },
  {
    id: 4,
    name: "codex-pro",
    primary: false,
    protocol: "responses",
    platform: "openai",
    models: ["gpt-5-pro"],
  },
  { ...groups[1]!, models: ["grok-4", "grok-4-fast"] },
];
const item = (id: string, groupId?: number, extra = {}) => ({
  id,
  displayName: id,
  description: "",
  badges: [],
  sort: 0,
  hidden: false,
  isDefault: false,
  usageHint: "",
  ...(groupId === undefined ? {} : { groupId }),
  ...extra,
});
const catalog: ModelCatalog = {
  defaultModel: "gpt-5",
  items: [
    item("gpt-5", 2),
    item("gpt-5-mini", 2),
    item("grok-4", 3, { isDefault: true }),
    item("grok-4-fast", 3),
  ],
};

test("each provider uses its chosen group, else the plan group, else its first", () => {
  const use = (choices: Record<string, number>) =>
    [...activeGroups(several, choices)].map(([id, group]) => [id, group.id]);
  assert.deepEqual(use({}), [
    ["openai", 2],
    ["xai", 3],
  ]);
  assert.deepEqual(use({ openai: 4 }), [
    ["openai", 4],
    ["xai", 3],
  ]);
  // A choice for a group the account no longer has, or another provider's, is ignored.
  assert.deepEqual(use({ openai: 99, xai: 4 }), [
    ["openai", 2],
    ["xai", 3],
  ]);
  assert.deepEqual(activeGroupIds(several, { openai: 4 }), [4, 3]);
  assert.deepEqual(activeGroupIds([], {}), []);
});

test("the menus list the models of the group in use for each provider", () => {
  const all: ModelCatalog = {
    defaultModel: "gpt-5",
    items: [
      item("gpt-5", 2),
      item("gpt-5-mini", 2),
      item("gpt-5-pro", 4),
      item("grok-4", 3, { isDefault: true }),
      item("grok-4-fast", 3),
    ],
  };
  assert.deepEqual(
    catalogInGroup(all, several, {})?.items.map((i) => i.id),
    ["gpt-5", "gpt-5-mini", "grok-4", "grok-4-fast"],
  );
  const pro = catalogInGroup(all, several, { openai: 4 })!;
  assert.deepEqual(
    pro.items.map((i) => i.id),
    ["gpt-5-pro", "grok-4", "grok-4-fast"],
  );
  // The administrator's default is not served any more: another default wins.
  assert.equal(pro.defaultModel, "grok-4");
});

test("one group, or no catalog, leaves the catalog as it is", () => {
  assert.equal(catalogInGroup(null, groups, {}), null);
  assert.equal(catalogInGroup(catalog, groups.slice(0, 1), {}), catalog);
});

test("models without a group belong to the plan group", () => {
  const plain: ModelCatalog = {
    defaultModel: null,
    items: [item("a"), item("b", 4), item("c", 3)],
  };
  const withPro: ServiceGroup[] = [
    groups[0]!,
    { ...several[1]!, models: undefined },
    groups[1]!,
  ];
  assert.deepEqual(
    catalogInGroup(plain, withPro, {})?.items.map((i) => i.id),
    ["a", "c"],
  );
  assert.deepEqual(
    catalogInGroup(plain, withPro, { openai: 4 })?.items.map((i) => i.id),
    ["b", "c"],
  );
});

test("the API page lists the providers the account has a group of, with their groups", () => {
  const page = apiGroupsFor(catalog, groups, { xai: 3 });
  // Each group lists its models (id and menu name) for the page's dropdown.
  for (const group of page.groups)
    assert.equal(group.modelList?.length, group.models, group.name);
  assert.deepEqual(
    page.groups.map(({ modelList: _list, ...rest }) => rest),
    [
      {
        id: 2,
        name: "codex",
        models: 2,
        primary: true,
        protocol: "responses",
        platform: "openai",
      },
      {
        id: 3,
        name: "grok",
        models: 2,
        primary: false,
        protocol: "chat",
        platform: "grok",
      },
    ],
  );
  assert.deepEqual(
    page.providers.map((p) => [
      p.id,
      p.name,
      p.groups.map((g) => g.id),
      p.selected,
    ]),
    [
      ["openai", "OpenAI", [2], 2],
      ["xai", "xAI", [3], 3],
    ],
  );
  // A platform the page does not know is a provider of its own, listed last.
  const other = apiGroupsFor(
    null,
    [
      ...groups,
      {
        id: 9,
        name: "mini",
        primary: false,
        protocol: "chat",
        platform: "minimax",
      },
    ],
    {},
  );
  assert.deepEqual(
    other.providers.slice(-1).map((p) => [p.id, p.name, p.selected]),
    [["minimax", "Minimax", 9]],
  );
});

test("a model several groups list belongs to each of them and goes out with the group in use", () => {
  const listing = [
    {
      groupId: 2,
      groupName: "codex",
      protocol: "responses" as const,
      keyId: "sub2api",
      primary: true,
      models: ["gpt-5", "grok-4"],
    },
    {
      groupId: 3,
      groupName: "grok",
      protocol: "chat" as const,
      keyId: "sub2api:g3",
      primary: false,
      models: ["grok-4"],
    },
  ];
  const owner = (preferred?: number) =>
    mergeGroupModels(listing, null, preferred).routes.map((route) => [
      route.groupId,
      route.models,
    ]);
  // Without a choice the plan group serves the shared model.
  assert.deepEqual(owner(), [
    [2, ["gpt-5", "grok-4"]],
    [3, []],
  ]);
  // With grok in use, its own key serves it.
  assert.deepEqual(owner(3), [
    [2, ["gpt-5"]],
    [3, ["grok-4"]],
  ]);
  // The menus list a group by what its key lists, not by who serves it.
  const both: ServiceGroup[] = [
    {
      id: 2,
      name: "codex",
      primary: true,
      protocol: "responses",
      platform: "openai",
      models: ["gpt-5", "grok-4"],
    },
    {
      id: 3,
      name: "grok",
      primary: false,
      protocol: "chat",
      platform: "grok",
      models: ["grok-4"],
    },
  ];
  const shared: ModelCatalog = {
    defaultModel: "gpt-5",
    items: [item("gpt-5", 2), item("grok-4", 2)],
  };
  assert.deepEqual(
    catalogInGroup(shared, both, {})?.items.map((i) => i.id),
    ["gpt-5", "grok-4"],
  );
  assert.equal(apiGroupsFor(shared, both, {}).groups[1].models, 1);
  assert.equal(apiGroupsFor(shared, both, {}).groups[0].models, 2);
  // Several providers' choices at once send each shared model with its group.
  assert.deepEqual(
    mergeGroupModels(listing, null, [3]).routes.map((r) => [
      r.groupId,
      r.models,
    ]),
    [
      [2, ["gpt-5"]],
      [3, ["grok-4"]],
    ],
  );
});

test("group rates: the account's own rate wins over the group's", async () => {
  const { groupRatesFrom, rateText } =
    await import("../../shared/api-keys-api");
  assert.deepEqual(
    groupRatesFrom(
      [
        { id: 2, rate_multiplier: 0.25 },
        { id: 3, rate_multiplier: 0.2 },
        { id: "x", rate_multiplier: 1 },
      ],
      { "3": 0.1, bad: 2 },
    ),
    { 2: 0.25, 3: 0.1 },
  );
  assert.deepEqual(groupRatesFrom(undefined, null), {});
  assert.equal(rateText(0.25), "0.25x");
  assert.equal(rateText(1), "1x");
});

test("a model the catalog gives a group shows even when the group's key does not list it", () => {
  // An OpenAI group's /v1/models is the pinned Codex manifest; the catalog
  // lists the group's models as its allowlist and accounts name them.
  const all: ModelCatalog = {
    defaultModel: "gpt-5",
    items: [item("gpt-5", 2), item("gpt-6.1-sol", 2), item("grok-4", 3)],
  };
  assert.deepEqual(
    catalogInGroup(all, several, {})?.items.map((i) => i.id),
    ["gpt-5", "gpt-6.1-sol", "grok-4"],
  );
  const page = apiGroupsFor(all, several, {});
  assert.equal(page.groups.find((g) => g.id === 2)?.models, 2);
});

test("each key carries what the service has charged for it in all", () => {
  const keys = apiKeysFrom([
    { id: 7, name: "社区论坛", key: "sk-87aaaaaaaa0cdf", group_id: 2 },
    { id: 8, name: "new", key: "sk-88bbbbbbbbbbbb", group_id: 2 },
  ]);
  const costed = withKeyCosts(keys, {
    "7": {
      api_key_id: 7,
      today_actual_cost: 0.5,
      total_actual_cost: 16.107432,
    },
  });
  assert.equal(costed.find((k) => k.id === 7)?.totalCost, 16.107432);
  // A key the stats do not name has not been charged yet.
  assert.equal(costed.find((k) => k.id === 8)?.totalCost, 0);
  // Without stats the key keeps no figure, and the page shows "—".
  assert.equal(keys[0].totalCost, undefined);
});
