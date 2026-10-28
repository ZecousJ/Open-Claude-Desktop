import assert from "node:assert/strict";
import test from "node:test";
import { collectionsFixture } from "../../scripts/preview/fixtures/collections";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import {
  directoryConnectors,
  isApprovedDirectoryEntries,
  featuredConnectorMembers,
} from "../../shared/connectors-catalogue";

function fixture(query: string) {
  const state = fixtureSnapshot({ history: "empty" });
  const before = structuredClone(state.host);
  const bridge = collectionsFixture.bridge({
    params: new URLSearchParams(query),
    state,
    origin: 1,
    emit() {},
  });
  return { state, before, bridge };
}

test("connector curation preview stays empty unless explicitly opted in", async () => {
  for (const query of [
    "",
    "connectorCuration=none",
    "connectorCuration=true",
  ]) {
    const { state, before, bridge } = fixture(query);
    assert.deepEqual(await bridge.listApprovedDirectory!(), []);
    assert.deepEqual(state.host, before);
  }
});

test("opt-in fixture supplies three truthful independent feature records through the existing bridge", async () => {
  const { state, before, bridge } = fixture("connectorCuration=some");
  const records = await bridge.listApprovedDirectory!();
  assert.ok(isApprovedDirectoryEntries(records));
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map((record) => record.id)).size, 3);
  for (const record of records) {
    assert.equal(record.kind, "mcp");
    assert.ok(record.name.startsWith("Fixture "));
    assert.equal(record.author, "Fixture directory publisher");
    assert.equal(new URL(record.url).hostname.endsWith(".example.test"), true);
    assert.ok(record.curation?.featured?.title);
    assert.ok(record.curation?.featured?.subtitle);
    assert.equal(
      record.curation?.featured?.curator,
      "Fixture directory curator",
    );
    assert.equal(record.curation?.iconUrl, undefined);
    assert.deepEqual(
      record.curation?.relatedIds,
      records
        .filter((other) => other.id !== record.id)
        .map((other) => other.id),
    );
  }
  const catalogue = directoryConnectors(records);
  for (const entry of catalogue.filter((entry) => entry.featured)) {
    assert.equal(entry.featured!.memberIds!.length, 2);
    assert.deepEqual(
      featuredConnectorMembers(entry, catalogue).map((member) => member.id),
      entry.featured!.memberIds,
    );
  }
  assert.equal(catalogue.length, directoryConnectors([]).length + 3);
  assert.deepEqual(
    catalogue.filter((entry) => entry.featured).map((entry) => entry.id),
    records.map((record) => record.id),
  );
  records[0].curation!.featured!.title = "Mutated by test";
  assert.notEqual(
    (await bridge.listApprovedDirectory!())[0].curation?.featured?.title,
    "Mutated by test",
  );
  assert.deepEqual(state.host, before);
  assert.deepEqual(await bridge.linearStatus!(), { connected: false });
});
