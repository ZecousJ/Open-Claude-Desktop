import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DesignSystemStore,
  designSources,
  designSystemInstructions,
  designSystemPrompt,
  designSystemsName,
} from "../../electron/artifacts/design-systems";
import {
  designFileRank,
  mergeSources,
  nameFromBlurb,
  readDesignSources,
} from "../../src/settings/directory/design-files";
import { designSourceLimit } from "../../shared/collections-api";

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "design-systems-"));
const settings = (designSystem: string) => ({ designSystem }) as never;

test("a design system is saved, changed, listed newest first and deleted", () => {
  let clock = 1000;
  const store = new DesignSystemStore(folder(), () => clock++);
  const first = store.save({
    name: "  Mission   Impastabowl ",
    blurb: "Pasta",
  });
  const second = store.save({ name: "Northwind", guidelines: "# Rules" });
  assert.equal(first.name, "Mission Impastabowl");
  assert.equal(first.guidelines, "");
  assert.equal(first.generatedAt, undefined);
  assert.ok(second.generatedAt, "guidelines written by hand count as written");
  assert.deepEqual(
    store.list().map((item) => item.name),
    ["Northwind", "Mission Impastabowl"],
  );
  const changed = store.save({
    id: first.id,
    name: "Impastabowl",
    notes: "warm",
  });
  assert.equal(changed.blurb, "Pasta", "fields left out are kept");
  assert.equal(changed.notes, "warm");
  assert.equal(store.list()[0].id, first.id, "changing moves it first");
  store.delete(first.id);
  assert.deepEqual(
    store.list().map((item) => item.id),
    [second.id],
  );
  store.delete("missing");
});

test("a design system needs a name, a unique one, and a record that exists", () => {
  const store = new DesignSystemStore(folder());
  assert.throws(() => store.save({ name: "   " }), /Enter a name/);
  const saved = store.save({ name: "Docs" });
  assert.throws(() => store.save({ name: "docs" }), /already exists/);
  assert.throws(() => store.save({ id: "gone", name: "Other" }), /is gone/);
  assert.equal(store.save({ id: saved.id, name: "DOCS" }).name, "DOCS");
  assert.throws(
    () => store.save({ name: "x".repeat(81) }),
    /up to 80 characters/,
  );
});

test("an unreadable file is reported and left alone", () => {
  const root = folder();
  fs.writeFileSync(path.join(root, designSystemsName), "{not json");
  const store = new DesignSystemStore(root);
  assert.throws(() => store.list(), /has not been overwritten/);
  assert.throws(() => store.save({ name: "New" }), /has not been overwritten/);
  assert.equal(
    fs.readFileSync(path.join(root, designSystemsName), "utf8"),
    "{not json",
  );
});

test("example files are checked and cut", () => {
  const long = "a".repeat(designSourceLimit + 500);
  const [kept] = designSources([{ name: "  tokens.css ", text: long }]);
  assert.equal(kept.name, "tokens.css");
  assert.equal(kept.text.length, designSourceLimit);
  assert.throws(() => designSources("no"), /invalid/);
  assert.throws(() => designSources([{ name: "", text: "x" }]), /invalid/);
  assert.throws(
    () =>
      designSources(
        Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, text: "x" })),
      ),
    /up to 20/,
  );
  assert.throws(
    () =>
      designSources(
        Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, text: long })),
      ),
    /too large/,
  );
});

test("the prompt carries the description, notes and each example file", () => {
  const store = new DesignSystemStore(folder());
  const system = store.save({
    name: "Mission",
    blurb: "Pasta kiosk",
    notes: "Rounded corners",
    sources: [{ name: "tokens.css", text: ":root{--a:#fff}" }],
  });
  const prompt = designSystemPrompt(system);
  assert.match(prompt.instructions, /CSS variables/);
  assert.match(prompt.input, /Name: Mission/);
  assert.match(prompt.input, /Pasta kiosk/);
  assert.match(prompt.input, /Rounded corners/);
  assert.match(prompt.input, /Example file tokens\.css:\n:root\{--a:#fff\}/);
});

test("only a chosen design system with guidelines is told to the model", () => {
  const root = folder();
  const store = new DesignSystemStore(root);
  const draft = store.save({ name: "Draft", blurb: "x" });
  const written = store.save({ name: "Written", guidelines: "# Colours\nred" });
  assert.equal(designSystemInstructions(root, settings("")), undefined);
  assert.equal(designSystemInstructions(root, settings("gone")), undefined);
  assert.equal(designSystemInstructions(root, settings(draft.id)), undefined);
  const text = designSystemInstructions(root, settings(written.id))!;
  assert.match(text, /“Written” is in use/);
  assert.match(text, /# Colours\nred/);
  const big = store.save({
    id: written.id,
    name: "Written",
    guidelines: "z".repeat(30_000),
  });
  assert.ok(designSystemInstructions(root, settings(big.id))!.length < 15_000);
  // A broken file must not stop a turn.
  fs.writeFileSync(path.join(root, designSystemsName), "nope");
  assert.equal(designSystemInstructions(root, settings(big.id)), undefined);
});

test("generated guidelines replace the old ones and stamp the time", () => {
  let clock = 5;
  const store = new DesignSystemStore(folder(), () => clock++);
  const saved = store.save({ name: "A", blurb: "b" });
  const next = store.setGenerated(saved.id, "# A");
  assert.equal(next.guidelines, "# A");
  assert.ok(next.generatedAt && next.generatedAt > saved.createdAt);
  assert.throws(() => store.setGenerated("gone", "x"), /is gone/);
});

test("names come from the first line of the description", () => {
  assert.equal(
    nameFromBlurb("Mission Impastabowl: fast-casual pasta restaurant"),
    "Mission Impastabowl",
  );
  assert.equal(nameFromBlurb(""), "Design system");
  assert.equal(nameFromBlurb("x".repeat(90)).length, 60);
  assert.deepEqual(
    mergeSources(
      [{ name: "a.css", text: "1" }],
      [
        { name: "a.css", text: "2" },
        { name: "b.css", text: "3" },
      ],
    ),
    [
      { name: "a.css", text: "2" },
      { name: "b.css", text: "3" },
    ],
  );
});

test("style and token files rank before code; dependencies and locks are skipped", () => {
  const rank = (name: string) => designFileRank(name)!;
  assert.ok(rank("src/theme/tokens.css") < rank("src/app.css"));
  assert.ok(rank("src/app.css") < rank("src/Button.tsx"));
  assert.equal(designFileRank("node_modules/x/index.css"), undefined);
  assert.equal(designFileRank("package.json"), undefined);
  assert.equal(designFileRank("logo.png"), undefined);
  assert.equal(designFileRank("pnpm-lock.yaml"), undefined);
});

test("readDesignSources keeps the most telling files, at most twenty", async () => {
  const file = (name: string, text: string) => {
    const item = new File([text], name.split("/").pop()!);
    Object.defineProperty(item, "webkitRelativePath", { value: name });
    return item;
  };
  const files = [
    file("a/Button.tsx", "export const B = 1"),
    file("a/tokens.css", ":root{--x:1}"),
    file("a/logo.png", "png"),
    file("a/empty.css", "   "),
    file("node_modules/z/index.css", "body{}"),
    ...Array.from({ length: 30 }, (_, i) => file(`a/c${i}.tsx`, `const c${i}`)),
  ];
  const sources = await readDesignSources(files);
  assert.equal(sources[0].name, "a/tokens.css");
  assert.equal(sources.length, 20);
  assert.ok(sources.every((s) => !/png|node_modules|empty/.test(s.name)));
});
