import test from "node:test";
import assert from "node:assert/strict";
import {
  createFixtureDesktop,
  fixtureSnapshot,
} from "../../scripts/preview/app-fixture";
import { artifactsFixture } from "../../scripts/preview/fixtures/artifacts";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import {
  artifactKind,
  canExportPresentation,
} from "../../src/artifacts/artifact-kind";
import { artifactIdentity } from "../../src/artifacts/artifact-metadata";
import type { Snapshot } from "../../shared/types";

const options = { history: "empty" as const, artifacts: true };
const artifacts = (snapshot: Snapshot) =>
  collectArtifacts(
    snapshot.conversations,
    snapshot.artifactShares,
    snapshot.artifactLibrary,
  );

test("slide fixture leaves every default conversation and artifact count unchanged", () => {
  for (const params of [
    new URLSearchParams(),
    new URLSearchParams("artifactSlides=0"),
  ]) {
    const state = fixtureSnapshot(options);
    const before = structuredClone(state);
    artifactsFixture.bridge({ params, state, origin: 1, emit() {} });
    assert.deepEqual(state, before);
    assert.equal(artifacts(state).length, artifacts(before).length);
  }
});

test("artifactSlides=1 adds exactly one collected, supported HTML slide deck through the real fixture bridge", async () => {
  const plain = createFixtureDesktop(
    options,
    new URLSearchParams("fonts=system"),
  );
  const enabled = createFixtureDesktop(
    options,
    new URLSearchParams("fonts=system&artifactSlides=1"),
  );
  const baseline = await plain.snapshot(),
    snapshot = await enabled.snapshot();
  const baselineArtifacts = artifacts(baseline),
    enabledArtifacts = artifacts(snapshot);
  assert.equal(
    snapshot.conversations.length,
    baseline.conversations.length + 1,
  );
  assert.equal(enabledArtifacts.length, baselineArtifacts.length + 1);
  assert.deepEqual(
    snapshot.host,
    baseline.host,
    "the synthetic file must not add backend capabilities",
  );
  const deck = enabledArtifacts.find(
    (value) => value.conversationId === "c-artifact-slides",
  )!;
  assert.ok(deck);
  assert.equal(deck.name, "Synthetic HTML slide deck");
  assert.equal(deck.filename, "synthetic-slides.html");
  assert.equal(artifactKind(deck), "html");
  assert.equal(deck.blob, undefined);
  assert.equal(deck.contentOmitted, undefined);
  assert.equal(canExportPresentation(deck), true);
  assert.equal((deck.content.match(/data-slide=/g) ?? []).length, 2);
  assert.equal((deck.content.match(/class="slide"/g) ?? []).length, 2);
  assert.doesNotMatch(deck.content, /https?:\/\/|<script\b/i);
});

test("slide fixture conversation, files and pin arrays belong to each individual fixture instance", async () => {
  const params = new URLSearchParams("fonts=system&artifactSlides=1");
  const first = createFixtureDesktop(options, params),
    second = createFixtureDesktop(options, params);
  const source = artifacts(await first.snapshot()).find(
    (value) => value.conversationId === "c-artifact-slides",
  )!;
  await first.pinArtifact(artifactIdentity(source), true);
  await first.deleteConversation("c-artifact-slides");
  const firstState = await first.snapshot(),
    secondState = await second.snapshot();
  assert.equal(
    firstState.conversations.some((value) => value.id === "c-artifact-slides"),
    false,
  );
  assert.equal(
    secondState.conversations.filter(
      (value) => value.id === "c-artifact-slides",
    ).length,
    1,
  );
  assert.deepEqual(secondState.artifactLibrary.pinned, []);
  const secondDeck = artifacts(secondState).find(
    (value) => value.conversationId === "c-artifact-slides",
  )!;
  assert.equal(secondDeck.content, source.content);
  assert.equal(canExportPresentation(secondDeck), true);
  const freshDefault = await createFixtureDesktop(options).snapshot();
  assert.equal(
    freshDefault.conversations.some(
      (value) => value.id === "c-artifact-slides",
    ),
    false,
  );
});
