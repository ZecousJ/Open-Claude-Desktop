import test from "node:test";
import assert from "node:assert/strict";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import type { AppEvent } from "../../shared/types";
import { browserColorSchemes, type BrowserState } from "../../shared/browser";
import { htmlDocument } from "../../src/artifacts/preview-document";

const fixture = (params = "") =>
  createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams(`fonts=system&${params}`),
  );

test("embedded-browser fixture preview keeps the exact sandbox document through an opaque data URL", async () => {
  const api = fixture("previewTransport=data");
  const document = htmlDocument(
    '<h1>预览 & "reference"</h1><script>console.log("ready")</script>',
  );
  const url = await api.createArtifactPreview(document);
  assert.match(url, /^data:text\/html;charset=utf-8,/);
  assert.equal(decodeURIComponent(url.slice(url.indexOf(",") + 1)), document);
  assert.match(document, /connect-src 'none'/);
  assert.match(document, /form-action 'none'/);
  await api.releaseArtifactPreview(url);
});

test("the fixture retains its default blob transport and releases the generated URL", async () => {
  const api = fixture();
  const document = htmlDocument("<h1>Blob transport</h1>");
  const url = await api.createArtifactPreview(document);
  assert.match(url, /^blob:/);
  assert.equal(await (await fetch(url)).text(), document);
  await api.releaseArtifactPreview(url);
  await assert.rejects(fetch(url));
});

test("the fixture deletes its signed-in account with the real zero-argument session API", async () => {
  const api = fixture();
  assert.ok((await api.authStatus()).account);
  assert.equal(api.deleteAccount.length, 0);
  assert.deepEqual(await api.deleteAccount(), { hasAccounts: false });
  assert.equal((await api.authStatus()).account, undefined);
});

test("every browser fixture variant returns a complete state with the host's system color-scheme default", async () => {
  for (const kind of [
    "empty",
    "page",
    "loading",
    "stalled",
    "error",
    "blocked",
    "crashed",
    "dialog",
    "tabs",
    "mobile",
    "picking",
  ]) {
    const api = fixture(`browser=${kind}`);
    const state: BrowserState = await api.browserState(`fixture-${kind}`);
    assert.equal(state.conversationId, `fixture-${kind}`);
    assert.equal(state.colorScheme, "system");
    assert.equal(state.viewport, kind === "mobile" ? "mobile" : "desktop");
    assert.ok(state.tabs.length > 0);
    assert.ok(state.tabs.some((tab) => tab.id === state.activeTabId));
    assert.ok(Array.isArray(state.devServers));
    assert.equal(typeof state.version, "number");
    assert.deepEqual(await api.browserOpen(state.conversationId), state);
  }
});

test("browser state and events keep the complete color-scheme protocol across updates and conversations", async () => {
  const api = fixture("browser=page&browserDev=servers");
  const events: AppEvent[] = [];
  const stop = api.onEvent((event) => events.push(event));
  try {
    const first = await api.browserState("browser-one");
    let previous = first;
    for (const scheme of browserColorSchemes) {
      const beforeEvents = events.length;
      await api.browserSetColorScheme("browser-one", scheme);
      const current = await api.browserState("browser-one");
      assert.equal(current.colorScheme, scheme);
      if (previous.colorScheme === scheme) {
        assert.equal(current.version, previous.version);
        assert.equal(events.length, beforeEvents);
      } else {
        assert.ok(current.version > previous.version);
        assert.deepEqual(events.at(-1), { type: "browser", state: current });
      }
      previous = current;
    }
    await api.browserSetColorScheme("browser-one", "dark");
    await api.browserSetViewport("browser-one", "mobile");
    const current = await api.browserState("browser-one");
    assert.equal(current.colorScheme, "dark");
    assert.equal(current.viewport, "mobile");
    assert.deepEqual(events.at(-1), { type: "browser", state: current });
    const started = await api.devServersStart("browser-one", "web");
    assert.equal(started.status, "running");
    assert.equal((await api.browserState("browser-one")).colorScheme, "dark");
    assert.equal((await api.browserState("browser-two")).colorScheme, "system");
    current.colorScheme = "light";
    current.tabs[0].title = "Mutated answer";
    assert.equal((await api.browserState("browser-one")).colorScheme, "dark");
    assert.notEqual(
      (await api.browserState("browser-one")).tabs[0].title,
      "Mutated answer",
    );
  } finally {
    stop();
  }
});

test("empty usage keeps every real totals field numeric and zero, with empty providers and records", async () => {
  const active = fixture("activity=1");
  const empty = fixture("activity=empty");
  const populated = await active.usageOverview();
  const overview = await empty.usageOverview();
  assert.ok(populated, "the active usage fixture returns an overview");
  assert.ok(overview, "the empty usage fixture returns an overview");
  assert.deepEqual(
    Object.keys(overview.totals).sort(),
    Object.keys(populated.totals).sort(),
  );
  assert.equal(Object.keys(overview.totals).length, 19);
  for (const value of Object.values(overview.totals)) assert.equal(value, 0);
  assert.deepEqual(overview.providers, []);
  assert.equal(populated.totals.requests, 18_432);
  assert.equal(populated.totals.todayRequests, 212);
  assert.equal(populated.providers.length, 2);
  assert.deepEqual(
    await empty.usageBreakdown({
      start: "2026-10-01",
      end: "2026-10-17",
      granularity: "day",
    }),
    { trend: [], models: [] },
  );
  assert.deepEqual(await empty.usageRecords({ page: 1, pageSize: 20 }), {
    items: [],
    total: 0,
    page: 1,
    pages: 1,
  });
});

test("project knowledge preview fixture retains actual added UTF-8 bytes and rejects removed or foreign files", async () => {
  const api = fixture("projects=some&knowledge=some");
  const p = (await api.snapshot()).projects[0].id;
  const listed = await api.listProjectKnowledge(p);
  const sample = await api.readProjectKnowledge(p, listed.files[0].name);
  assert.equal(sample.kind, "text");
  if (sample.kind === "text")
    assert.match(sample.text, /Synthetic local acceptance fixture/);
  await api.addProjectKnowledgeText(p, {
    name: "Actual fixture",
    text: "<b>中文</b>",
  });
  const read = await api.readProjectKnowledge(p, "Actual fixture.md");
  assert.deepEqual(read, {
    name: "Actual fixture.md",
    bytes: new TextEncoder().encode("<b>中文</b>").length,
    kind: "text",
    text: "<b>中文</b>",
  });
  await api.removeProjectKnowledge(p, ["Actual fixture.md"]);
  await assert.rejects(api.readProjectKnowledge(p, "Actual fixture.md"));
  await assert.rejects(
    api.readProjectKnowledge("other-project", listed.files[0].name),
  );
});

test("knowledge preview acceptance uses real delimited text and the existing valid PDF fixture", async () => {
  const api = fixture("projects=some&knowledge=preview");
  const p = (await api.snapshot()).projects[0].id;
  const csv = await api.readProjectKnowledge(p, "project-sample.csv");
  assert.equal(csv.kind, "text");
  if (csv.kind === "text")
    assert.equal(csv.text, "item,value\nalpha,1\nbeta,2\n");
  const pdf = await api.readProjectKnowledge(p, "summary.pdf");
  assert.equal(pdf.kind, "pdf");
  if (pdf.kind === "pdf") assert.ok(atob(pdf.base64).startsWith("%PDF-1.4"));
});
