import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import type { Artifact } from "../../src/ui/ArtifactTypes";
// Match Vite's web bundle constant before loading any renderer module. Each
// Node test file runs in an isolated process; a HostInfo snapshot cannot
// change this immutable build-time choice.
Object.defineProperty(globalThis, "__CLAUDEX_SURFACE__", {
  configurable: true,
  value: "web",
});
after(() => Reflect.deleteProperty(globalThis, "__CLAUDEX_SURFACE__"));
const { routineDom } = await import("../support/routine-dom");
const { ArtifactPanel } = await import("../../src/artifacts/FileViewer");
test("the actual web ArtifactPanel marks only a full-page collaboration surface standalone", async (t) => {
  const env = await routineDom(
    {
      artifactNotes: async () => ({}),
      sharingStatus: async () => ({ enabled: false }),
    } as never,
    { jsdom: true },
  );
  t.after(env.clean);
  const previousMedia = Object.getOwnPropertyDescriptor(
    globalThis,
    "matchMedia",
  );
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  t.after(() => {
    if (previousMedia)
      Object.defineProperty(globalThis, "matchMedia", previousMedia);
    else Reflect.deleteProperty(globalThis, "matchMedia");
  });
  const artifact = {
    id: "frame",
    name: "Frame",
    language: "html",
    content: "<p>Frame</p>",
    surface: "artifact",
  } as Artifact;
  const props = { artifact, onClose() {}, onError() {} };
  await env.render(h(ArtifactPanel, { ...props, fullPage: true }));
  assert.ok(env.document.querySelector(".artifact-panel[data-standalone]"));
  await env.render(h(ArtifactPanel, { ...props, fullPage: false }));
  assert.equal(
    env.document.querySelector(".artifact-panel[data-standalone]"),
    null,
  );
  await env.render(
    h(ArtifactPanel, {
      ...props,
      artifact: { ...artifact, surface: "file" },
      fullPage: true,
    }),
  );
  assert.equal(
    env.document.querySelector(".artifact-panel[data-standalone]"),
    null,
  );
});
