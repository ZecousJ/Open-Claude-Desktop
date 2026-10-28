import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { locales, sourceLocale } from "../../shared/locales";
import { AppContext, type AppController } from "../../src/app/AppContext";
import CoworkIdeas from "../../src/cowork/CoworkIdeas";
import {
  coworkIdeaCategories,
  coworkIdeasHidden,
  coworkIdeasHiddenKey,
  hideCoworkIdeas,
  nextIdeaCategory,
} from "../../src/cowork/cowork-ideas";

test("the first set is the home's ideas, then the other sets in order", () => {
  assert.deepEqual(
    coworkIdeaCategories.map((category) => category.name),
    [
      "Ideas for you",
      "Start with something small",
      "Clear the clutter",
      "Get ready for what’s next",
      "Make sense of scattered information",
    ],
  );
  assert.deepEqual(
    coworkIdeaCategories[0]!.ideas.map((idea) => idea.label),
    [
      "Send me a daily briefing",
      "Organize my inbox",
      "Customize Cowork for me",
    ],
  );
  for (const category of coworkIdeaCategories) {
    assert.equal(category.ideas.length, 3, category.name);
    for (const idea of category.ideas) {
      assert.ok(idea.label.trim(), idea.id);
      assert.ok(idea.prompt.trim(), idea.id);
    }
  }
  const ids = coworkIdeaCategories.map((category) => category.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the shuffle steps to the next set and wraps around", () => {
  const count = coworkIdeaCategories.length;
  assert.equal(nextIdeaCategory(0), 1);
  assert.equal(nextIdeaCategory(count - 1), 0);
  assert.equal(nextIdeaCategory(0, 0), 0);
  // Every set comes round once per lap.
  const seen = new Set<number>();
  for (let i = 0, at = 0; i < count; i++, at = nextIdeaCategory(at))
    seen.add(at);
  assert.equal(seen.size, count);
});

test("Hide suggestions is remembered, and blocked storage does not break the home", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  assert.equal(coworkIdeasHidden(storage), false);
  hideCoworkIdeas(storage);
  assert.equal(store.get(coworkIdeasHiddenKey), "1");
  assert.equal(coworkIdeasHidden(storage), true);
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(coworkIdeasHidden(blocked), false);
  assert.doesNotThrow(() => hideCoworkIdeas(blocked));
  assert.equal(coworkIdeasHidden(undefined), false);
});

test("the ideas show the set's name on the shuffle button, the X, three rows and the plugins button", () => {
  const plain = renderToStaticMarkup(
    createElement(CoworkIdeas, { onPick: () => {} }),
  );
  assert.match(
    plain,
    /class="cowork-ideas-shuffle"><svg[^]*?<span>Ideas for you<\/span><\/button>/,
  );
  assert.match(
    plain,
    /class="cowork-ideas-hide" aria-label="Hide suggestions"/,
  );
  assert.equal(plain.match(/class="cowork-idea"/g)?.length, 3);
  assert.match(plain, /Send me a daily briefing/);
  assert.equal(plain.match(/cowork-idea-caret/g)?.length, 3);
  // Without the app (no Plugins page to open) there is no plugins button.
  assert.doesNotMatch(plain, /Customize with plugins/);
  const app = { openSettingsTab: () => {} } as unknown as AppController;
  const withApp = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(CoworkIdeas, { onPick: () => {} }),
    ),
  );
  assert.match(
    withApp,
    /<button type="button" class="cowork-ideas-plugins">Customize with plugins<\/button>/,
  );
});

/** Every catalog entry, plus the translations waiting in i18n-pending/. */
async function translations(id: string) {
  const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
    .default as Record<string, string>;
  const known = new Set(Object.keys(catalog));
  const pending = join(import.meta.dirname, "..", "..", "i18n-pending");
  if (existsSync(pending))
    for (const file of readdirSync(pending).filter((f) => f.endsWith(".json")))
      for (const [english, byLocale] of Object.entries(
        JSON.parse(readFileSync(join(pending, file), "utf8")) as Record<
          string,
          Record<string, string>
        >,
      ))
        if (byLocale[id]) known.add(english);
  return known;
}

test("every set name, label and prompt, the plugins button and the folder line are translated", async () => {
  const texts = [
    "Customize with plugins",
    "On {deviceName}",
    ...coworkIdeaCategories.flatMap((category) => [
      category.name,
      ...category.ideas.flatMap((idea) => [idea.label, idea.prompt]),
    ]),
  ];
  for (const { id } of locales.filter(({ id }) => id !== sourceLocale)) {
    const known = await translations(id);
    for (const text of texts)
      assert.ok(known.has(text), `${id}: ${text.slice(0, 60)}`);
  }
});
