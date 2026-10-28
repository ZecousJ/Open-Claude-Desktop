import test from "node:test";
import assert from "node:assert/strict";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";

const fixture = (query = "") =>
  createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams(`fonts=system&${query}`),
  );

test("ordinary fixture catalog has the real no-catalog null contract", async () => {
  assert.equal(await fixture().modelCatalog(), null);
});

test("empty skill-menu inventory is explicit and does not change ordinary built-ins", async () => {
  assert.deepEqual(await fixture("skillMenu=empty").customizeSkills(), []);
  assert.ok((await fixture().customizeSkills()).length > 0);
});

test("explicit catalog retry scenario fails once then returns its own published provider models", async () => {
  const api = fixture("catalog=error-once&catalogExtra=30&catalogDelay=5");
  await assert.rejects(
    api.modelCatalog(),
    /Offline fixture catalog request failed/,
  );
  const catalog = await api.modelCatalog();
  const snapshot = await api.snapshot();
  assert.ok(catalog);
  assert.equal(
    catalog.items.filter((item) => item.id.startsWith("qa-model-")).length,
    30,
  );
  assert.ok(
    catalog.items.every((item) =>
      snapshot.settings.providers.some(
        (p) => p.model === item.id || p.models.includes(item.id),
      ),
    ),
  );
  assert.equal(
    (await fixture().snapshot()).settings.providers.some((p) =>
      p.models.some((id) => id.startsWith("qa-model-")),
    ),
    false,
  );
});

test("skills and design failures are independent and retry the actual underlying fixture lists", async () => {
  const api = fixture("skills=some&skillsFailure=once&designsFailure=always");
  await assert.rejects(api.customizeSkills(), /fixture skills request failed/);
  assert.ok((await api.customizeSkills()).length);
  await assert.rejects(
    api.listDesignSystems(),
    /fixture designs request failed/,
  );
  await assert.rejects(
    api.listDesignSystems(),
    /fixture designs request failed/,
  );
  assert.ok(Array.isArray(await fixture("skills=none").customizeSkills()));
});

test("explicit partial project reads preserve failure and known cache through delayed snapshot retries", async () => {
  const first = fixture("projectCatalog=failed&projectCatalogDelay=5");
  const freshFailure = await first.snapshot();
  assert.deepEqual(freshFailure.projectCatalog, {
    status: "failed",
    cached: false,
  });
  assert.deepEqual(freshFailure.projects, []);
  assert.deepEqual(
    (await first.snapshot()).projectCatalog,
    freshFailure.projectCatalog,
  );
  const cached = fixture("projectCatalog=cached&projectCatalogDelay=5");
  const before = await cached.snapshot();
  assert.deepEqual(before.projectCatalog, { status: "failed", cached: true });
  assert.deepEqual(
    before.projects.map((p) => p.id),
    ["qa-cached-cloud-project"],
  );
  const retried = await cached.snapshot();
  assert.deepEqual(retried.projectCatalog, before.projectCatalog);
  assert.deepEqual(retried.projects, before.projects);
  assert.equal((await fixture().snapshot()).projectCatalog, undefined);
});
