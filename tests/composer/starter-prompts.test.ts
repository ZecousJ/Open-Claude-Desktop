import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { locales, sourceLocale } from "../../shared/locales";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StarterCategoryIcon } from "../../src/starter-prompts/StarterCategoryIcon";
import { starterIntegrations } from "../../shared/starter-integrations";
import {
  onComposerSubmitRequest,
  requestComposerSubmit,
} from "../../src/composer/submit-request";
import {
  customConnectorEntry,
  mcpServerStates,
} from "../../electron/connectors/mcp-config-file";
import {
  homeStarterCategories,
  moveChipFocus,
  moveStarterFocus,
  starterCategories,
  availableStarterCategories,
  visibleStarterCategories,
  starterPromptTemplate,
  starterPromptTemplates,
  starterTimeOfDay,
  type StarterCategory,
} from "../../src/starter-prompts/starter-prompts";

test("starter clicks send only the matching composer without attached or pending resources", () => {
  const resources = { attached: 0, pending: 0 };
  let submissions = 0;
  let otherSubmissions = 0;
  const unsubscribe = onComposerSubmitRequest(
    "home:chat",
    () => submissions++,
    () => resources.attached > 0 || resources.pending > 0,
  );
  const unsubscribeOther = onComposerSubmitRequest(
    "other:chat",
    () => otherSubmissions++,
  );
  try {
    requestComposerSubmit("home:chat", { withoutResources: true });
    assert.equal(submissions, 1);
    assert.equal(otherSubmissions, 0);
    resources.attached = 1;
    requestComposerSubmit("home:chat", { withoutResources: true });
    assert.equal(submissions, 1);
    requestComposerSubmit("home:chat");
    assert.equal(
      submissions,
      2,
      "normal Send still submits attached resources",
    );
    resources.attached = 0;
    resources.pending = 1;
    requestComposerSubmit("home:chat", { withoutResources: true });
    assert.equal(
      submissions,
      2,
      "pending uploads keep the prompt in the draft",
    );
    resources.pending = 0;
    assert.equal(submissions, 2, "finishing an upload must not send the draft");
  } finally {
    unsubscribe();
    unsubscribeOther();
  }
  requestComposerSubmit("home:chat", { withoutResources: true });
  assert.equal(submissions, 2);
});

test("current home templates use Hi/Hey rather than the separate new-user template", () => {
  assert.ok(
    starterPromptTemplates.default.startsWith(
      "Hi Claudex! Could you {prompt}?",
    ),
  );
  assert.ok(!starterPromptTemplates.default.includes("new here"));
  assert.ok(
    starterPromptTemplates.connector.startsWith(
      "Hey Claudex, could you {prompt}?",
    ),
  );
  assert.ok(
    starterPromptTemplates.research.startsWith(
      "Hey Claudex, could you help me {prompt}?",
    ),
  );
});

test("the catalog keeps its ids unique and its connector ideas behind their connectors", () => {
  const prompts = starterCategories.flatMap((category) => category.prompts);
  assert.equal(prompts.length, 66);
  assert.equal(new Set(prompts.map((prompt) => prompt.id)).size, 66);
  for (const id of ["drive", "calendar", "gmail"])
    for (const prompt of starterCategories.find((item) => item.id === id)!
      .prompts)
      assert.ok(prompt.requiredIntegrations?.includes(id as never), prompt.id);
});

test("every starter label and prompt template is translated in all locales", async () => {
  const messages = new Set([
    ...starterCategories.flatMap((category) => [
      category.title,
      ...category.prompts.map((prompt) => prompt.label),
    ]),
    ...Object.values(starterPromptTemplates),
    "Integration",
    "Choose a valid connector.",
  ]);
  for (const { id } of locales.filter(({ id }) => id !== sourceLocale)) {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    for (const message of messages) {
      assert.ok(catalog[message]?.trim(), `${id}: ${message}`);
      if (message.includes("{prompt}"))
        assert.equal(catalog[message].match(/\{prompt\}/g)?.length, 1);
    }
  }
});

test("every category has ideas, each with a line and a prompt", () => {
  assert.ok(starterCategories.length >= 5);
  const ids = new Set<string>();
  for (const category of starterCategories) {
    assert.ok(category.title.trim(), `${category.id} has a title`);
    assert.ok(category.prompts.length >= 3, `${category.id} has ideas`);
    for (const item of category.prompts) {
      assert.ok(!ids.has(item.id), `${item.id} is unique`);
      ids.add(item.id);
      assert.ok(item.label.trim(), item.id);
      assert.ok(starterPromptTemplate(category).includes("{prompt}"));
    }
  }
  assert.equal(
    new Set(starterCategories.map((category) => category.id)).size,
    starterCategories.length,
  );
});

test("the category names are kept", () => {
  const titles = starterCategories.map((category) => category.title);
  for (const name of [
    "Write",
    "Learn",
    "Code",
    "Create",
    "Career chat",
    "Life stuff",
    "Research",
    "Claudex’s choice",
    "From Calendar",
    "From Gmail",
    "From Drive",
  ])
    assert.ok(titles.includes(name), name);
});

test("the arrow keys move through the list and stop at its ends", () => {
  assert.equal(moveStarterFocus("ArrowDown", 0, 5), 1);
  assert.equal(moveStarterFocus("ArrowDown", 4, 5), 4);
  assert.equal(moveStarterFocus("ArrowUp", 0, 5), 0);
  assert.equal(moveStarterFocus("ArrowUp", 3, 5), 2);
  assert.equal(moveStarterFocus("Home", 3, 5), 0);
  assert.equal(moveStarterFocus("End", 1, 5), 4);
  assert.equal(moveStarterFocus("a", 1, 5), undefined);
});

test("Other keeps the official fill arithmetic without pretending to have Raven seats", () => {
  assert.deepEqual(
    homeStarterCategories().map((category) => category.id),
    [
      "writing_content_creation",
      "learning_studying",
      "coding_development",
      "life_stuff",
      "claudes_choice",
    ],
  );
  assert.deepEqual(
    homeStarterCategories(undefined, {
      integrations: ["compass", "calendar", "gmail", "drive"],
    }).map((category) => category.id),
    [
      "research_analysis",
      "writing_content_creation",
      "learning_studying",
      "coding_development",
      "life_stuff",
      "claudes_choice",
      "calendar",
      "gmail",
      "drive",
    ],
  );
});

test("the rendered home hides Research and reserves connector slots before fill", () => {
  assert.deepEqual(
    visibleStarterCategories(
      homeStarterCategories(undefined, { integrations: ["compass"] }),
    ).map((category) => category.id),
    [
      "writing_content_creation",
      "learning_studying",
      "coding_development",
      "life_stuff",
      "claudes_choice",
    ],
  );
  assert.deepEqual(
    visibleStarterCategories(
      homeStarterCategories(undefined, {
        integrations: ["compass", "calendar", "gmail", "drive"],
      }),
    ).map((category) => category.id),
    [
      "writing_content_creation",
      "learning_studying",
      "drive",
      "calendar",
      "gmail",
    ],
  );
});

test("work-function preferences keep official ordering and deduplicate Research", () => {
  const ids = homeStarterCategories(undefined, {
    workType: "Engineering",
    integrations: ["compass"],
  }).map((category) => category.id);
  assert.deepEqual(ids, [
    "research_analysis",
    "coding_development",
    "writing_content_creation",
    "life_stuff",
    "claudes_choice",
  ]);
  assert.equal(ids.filter((id) => id === "research_analysis").length, 1);
  assert.deepEqual(
    homeStarterCategories(undefined, { workType: "SoftwareEngineer" }).map(
      (category) => category.id,
    ),
    [
      "coding_development",
      "writing_content_creation",
      "life_stuff",
      "claudes_choice",
    ],
  );
});

test("prompts shuffle deterministically per mount, without shuffling chip order or mutating the catalog", () => {
  const before = JSON.stringify(starterCategories);
  const options = {
    seed: 123,
    integrations: ["compass", "calendar", "gmail", "drive"] as const,
  };
  const first = homeStarterCategories(undefined, options);
  assert.deepEqual(first, homeStarterCategories(undefined, options));
  const second = homeStarterCategories(undefined, { ...options, seed: 456 });
  assert.deepEqual(
    first.map((category) => category.id),
    second.map((category) => category.id),
  );
  assert.notDeepEqual(first[0].prompts, second[0].prompts);
  assert.equal(JSON.stringify(starterCategories), before);
});

test("time and all required integrations gate prompts before dropping empty categories", () => {
  assert.deepEqual([0, 11, 12, 16, 17, 23].map(starterTimeOfDay), [
    "morning",
    "morning",
    "afternoon",
    "afternoon",
    "evening",
    "evening",
  ]);
  const category: StarterCategory = {
    id: "example",
    title: "Example",
    icon: "coffee",
    prompts: [
      { id: "morning", label: "Morning", timeOfDay: "morning" },
      { id: "afternoon", label: "Afternoon", timeOfDay: "afternoon" },
      { id: "both", label: "Both", requiredIntegrations: ["gmail", "drive"] },
    ],
  };
  assert.deepEqual(
    availableStarterCategories([category], { hour: 8 }).flatMap((item) =>
      item.prompts.map((prompt) => prompt.id),
    ),
    ["morning"],
  );
  assert.deepEqual(
    availableStarterCategories([category], {
      hour: 18,
      integrations: ["gmail"],
    }),
    [],
  );
  assert.deepEqual(
    availableStarterCategories([category], {
      hour: 18,
      integrations: ["gmail", "drive"],
    })[0].prompts.map((prompt) => prompt.id),
    ["both"],
  );
  assert.ok(
    !availableStarterCategories().some(
      (item) =>
        item.id === "research_analysis" ||
        item.id === "calendar" ||
        item.id === "gmail" ||
        item.id === "drive" ||
        item.id === "career_chat",
    ),
  );
  assert.ok(
    availableStarterCategories(undefined, { integrations: ["drive"] })
      .flatMap((item) => item.prompts)
      .every((item) => !item.requiredIntegrations?.includes("compass")),
  );
});

test("connector identity survives desktop/runner configuration and requires a connected server", () => {
  const [name, config] = customConnectorEntry(
    { name: "my-mail", url: "https://example.com/mcp", connectorId: "gmail" },
    {},
  );
  const live = mcpServerStates({ [name]: config }, true, new Map(), [
    { name, authStatus: "oAuth", tools: {} },
  ]);
  assert.deepEqual(starterIntegrations(live), ["gmail"]);
  for (const state of ["failed", "starting", "disabled", "stopped"] as const)
    assert.deepEqual(starterIntegrations([{ ...live[0], state }]), []);
  assert.deepEqual(
    starterIntegrations([{ ...live[0], authStatus: "notLoggedIn" }]),
    [],
  );
  assert.deepEqual(
    starterIntegrations([
      { name: "not-google-drive", state: "ready", tools: 1 },
    ]),
    [],
  );
  assert.deepEqual(
    starterIntegrations([
      {
        name: "google-drive",
        connectorId: "google-drive",
        state: "ready",
        tools: 1,
        authStatus: "bearerToken",
      },
    ]),
    ["drive"],
  );
  assert.deepEqual(
    starterIntegrations([
      { name: "google-drive", state: "ready", tools: 1 },
      { name: "gmail", state: "ready", tools: 1 },
    ]),
    [],
  );
  assert.throws(
    () =>
      customConnectorEntry(
        {
          name: "invalid",
          url: "https://example.com",
          connectorId: "other" as "gmail",
        },
        {},
      ),
    /valid connector/,
  );
});

test("official glyphs use the 20px optical outlines and 14px branded connector marks", () => {
  const research = renderToStaticMarkup(
    createElement(StarterCategoryIcon, { icon: "binoculars" }),
  );
  assert.match(research, /width="20" height="20"/);
  assert.match(research, /lucide-binoculars/);
  const gmail = renderToStaticMarkup(
    createElement(StarterCategoryIcon, { icon: "gmail" }),
  );
  assert.match(gmail, /width="14" height="14"/);
  assert.match(gmail, /#4285F4/);
  assert.notEqual(
    gmail,
    renderToStaticMarkup(createElement(StarterCategoryIcon, { icon: "drive" })),
  );
});

test("the arrow keys move along the chips and wrap around", () => {
  assert.equal(moveChipFocus("ArrowRight", 0, 5), 1);
  assert.equal(moveChipFocus("ArrowDown", 4, 5), 0);
  assert.equal(moveChipFocus("ArrowLeft", 0, 5), 4);
  assert.equal(moveChipFocus("ArrowUp", 3, 5), 2);
  assert.equal(moveChipFocus("ArrowRight", -1, 5), 0);
  assert.equal(moveChipFocus("Enter", 1, 5), undefined);
  assert.equal(moveChipFocus("ArrowRight", 0, 0), undefined);
});
