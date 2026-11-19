import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import {
  textureGrid,
  windForSeed,
  chooseLook,
  TextureHand,
  textureReceivesTap,
} from "../../src/code-home/landing-texture-model";
import { createFixtureDesktop } from "../../scripts/fidelity/app-fixture";
const reference = JSON.parse(
  readFileSync("tests/fixtures/code-texture-reference.json", "utf8"),
);

test("Code grid, seed parameters and nonrepeating look selection match reference numeric observations", () => {
  for (const { args, value } of reference.grids)
    assert.deepEqual(textureGrid(args[0], args[1], args[2]), value);
  for (const { seed, value, looks } of reference.winds) {
    const local = windForSeed(seed);
    assert.deepEqual(local, {
      heading: value.heading,
      speed: value.speed,
      length: value.gustLength,
      width: value.gustWidth,
      bend: value.bend,
      bendScale: value.bendScale,
    });
    for (const { recent, value } of looks)
      assert.equal(chooseLook(seed, recent), value);
  }
});

test("clicks, every-third heart, speed-filtered trails and expiry match reference snapshots", () => {
  const hand = new TextureHand();
  let index = 0;
  for (const [action, ...args] of reference.actions) {
    if (action === "tap") hand.tap(args[0], args[1], args[2]);
    else if (action === "move") hand.move(args[0], args[1], args[2]);
    else if (action === "leave") hand.leave();
    else {
      const actual = hand.frame(args[0]),
        expected = reference.frames[index++];
      assert.equal(actual.tapCount, expected.tapCount);
      assert.equal(actual.wakeCount, expected.wakeCount);
      for (const key of ["taps", "wakes", "ways"] as const) {
        const count = (key === "taps" ? actual.tapCount : actual.wakeCount) * 4;
        assert.deepEqual([...actual[key]].slice(0, count), expected[key]);
      }
    }
  }
  assert.equal(reference.frames[0].taps[11], -1.149999976158142);
  assert.equal(hand.busy(10), false);
});

test("only primary presses on background produce ripples; nested interactive controls are excluded", () => {
  const { document } = parseHTML(
    '<main><div id="air"></div><button><svg id="icon"></svg></button><textarea></textarea><div role="combobox"><span id="item"></span></div><div contenteditable="true" id="edit"></div><p id="plain">Text</p></main>',
  );
  const parent = document.querySelector("main")!;
  for (const selector of ["button", "#icon", "textarea", "#item", "#edit"])
    assert.equal(
      textureReceivesTap(document.querySelector(selector), parent, 0),
      false,
    );
  for (const selector of ["#air", "#plain"])
    assert.equal(
      textureReceivesTap(document.querySelector(selector), parent, 0),
      true,
    );
  assert.equal(textureReceivesTap(parent, parent, 0), true);
  assert.equal(textureReceivesTap(parent, parent, 2), false);
});

test("cloud-preview fixture returns actual-shaped explicit data, persists edits and preserves empty/error states", async () => {
  const api = createFixtureDesktop(
    {},
    new URLSearchParams("fonts=system&environments=some"),
  );
  const rows = await api.listCloudEnvironments();
  assert.deepEqual(await api.getTaskBacklog("/synthetic-preview", 20), []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Preview workspace");
  const edited = await api.saveCloudEnvironment({
    ...rows[0],
    name: "Renamed preview",
  });
  assert.equal((await api.listCloudEnvironments())[0].name, edited.name);
  await api.archiveCloudEnvironment(rows[0].id);
  assert.deepEqual(await api.listCloudEnvironments(), []);
  assert.deepEqual(
    await createFixtureDesktop(
      {},
      new URLSearchParams("fonts=system&environments=empty"),
    ).listCloudEnvironments(),
    [],
  );
  await assert.rejects(
    createFixtureDesktop(
      {},
      new URLSearchParams("fonts=system&environments=error"),
    ).listCloudEnvironments(),
    /Synthetic/,
  );
});
