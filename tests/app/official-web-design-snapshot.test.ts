import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { blankArtifactInitialContent } from "../../shared/blank-artifacts";
import type {
  AppEvent,
  Conversation,
  Snapshot,
  Turn,
} from "../../shared/types";

const account = "owner";
const organization = "22111111-1111-4111-8111-111111111111";
const artifact = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "design",
  name: "Design",
  file: "design.svg",
  createdAt: 1,
} satisfies NonNullable<Conversation["blankArtifact"]>;
const running: Turn = {
  id: "turn",
  prompt: "Edit the design",
  items: [],
  attachments: [],
  status: "inProgress",
  createdAt: 2,
};
const design: Conversation = {
  id: "design-chat",
  mode: "chat",
  title: "Original title",
  providerId: "provider",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  projectOrganizationId: organization,
  sessionAuthors: { viewerAccountUuid: account, ownerAccountUuid: account },
  turns: [running],
  blankArtifact: artifact,
};

let buildHost:
  | Promise<typeof import("../../src-web/official/OfficialWebSurface")>
  | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadHost() {
  return (buildHost ??= (async () => {
    const file = path.resolve(
      ".runtime",
      `official-web-design-snapshot-${process.pid}.mjs`,
    );
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      await build({
        entryPoints: [path.resolve("src-web/official/OfficialWebSurface.tsx")],
        outfile: file,
        bundle: true,
        platform: "node",
        format: "esm",
        external: ["react"],
        loader: { ".css": "empty", ".svg": "text" },
      });
      return await import(pathToFileURL(file).href);
    } finally {
      rmSync(file, { force: true });
    }
  })());
}

async function fixture(t: TestContext) {
  const { OfficialWebSurface } = await loadHost();
  const dom = new JSDOM('<div id="root"></div>', {
    url: `https://fixture.invalid/code/artifact/${artifact.id}?org=${organization}`,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    DOMParser: dom.window.DOMParser,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(globalThis, globals);

  type DesignSnapshot = Pick<Snapshot, "conversations">;
  const reads: ReturnType<typeof deferred<DesignSnapshot>>[] = [];
  const listeners = new Set<(event: AppEvent) => void>();
  const bridge = {
    api: {
      snapshot: () => {
        const read = deferred<DesignSnapshot>();
        reads.push(read);
        return read.promise;
      },
      readBlankArtifact: async () => ({
        conversationId: design.id,
        artifact,
        content: blankArtifactInitialContent("design"),
        revision: "revision",
        writable: true,
      }),
    },
    auth: {
      activationIdentity: {},
      current: { account: { id: account } },
      onChange: () => () => {},
    },
    dispatch: {},
    officialAnnouncements: {},
    officialZecousMigration: {},
    officialUiRead: async () => ({
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(
        JSON.stringify({
          uuid: account,
          memberships: [
            { organization: { uuid: organization, capabilities: ["chat"] } },
          ],
        }),
      ),
    }),
    officialUiEvents: (listener: (event: AppEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
  await act(async () =>
    root.render(
      React.createElement(OfficialWebSurface, {
        bridge: bridge as unknown as React.ComponentProps<
          typeof OfficialWebSurface
        >["bridge"],
        accountId: account,
      }),
    ),
  );

  const frame = document.querySelector("iframe");
  assert.ok(frame?.contentWindow && frame.contentDocument);
  const bindings = window.__claudexOfficialFrameBindings?.(
    frame.contentWindow,
    frame.contentDocument,
  );
  assert.ok(bindings);
  await act(async () => {
    await bindings.read({ method: "GET", path: "/api/account" });
  });

  return {
    emit: async (event: AppEvent) => {
      await act(async () => listeners.forEach((listen) => listen(event)));
    },
    respond: async (...conversations: Conversation[]) => {
      const read = reads.shift();
      assert.ok(read, "The host asked for a snapshot");
      await act(async () => read.resolve({ conversations }));
    },
    artboard: () => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Artboard"]',
      );
      assert.ok(button);
      return button;
    },
    designTitle: () =>
      container
        .querySelector('main[data-blank-kind="design"]')
        ?.getAttribute("aria-label"),
  };
}

test("initial Design read keeps a terminal turn received before the canvas exists", async (t) => {
  const host = await fixture(t);
  await host.emit({
    type: "conversation-turn",
    conversationId: design.id,
    turn: { ...running, status: "completed" },
    conversation: { updatedAt: 3 },
  });
  await host.respond(design);
  assert.equal(host.artboard().disabled, false);
});

test("Design resync keeps newer full and terminal turn events", async (t) => {
  const host = await fixture(t);
  await host.respond(design);
  assert.equal(host.artboard().disabled, true);

  await host.emit({ type: "resync" });
  await host.emit({
    type: "conversation",
    conversation: { ...design, title: "Renamed during reconnect" },
  });
  await host.emit({
    type: "conversation-turn",
    conversationId: design.id,
    turn: { ...running, status: "completed" },
    conversation: { updatedAt: 3 },
  });
  assert.equal(host.artboard().disabled, false);

  await host.respond(design);
  assert.equal(host.designTitle(), "Renamed during reconnect");
  assert.equal(host.artboard().disabled, false);
});

test("Design resync keeps snapshot metadata with a terminal turn received during the read", async (t) => {
  const host = await fixture(t);
  await host.respond({ ...design, turns: [] });
  await host.emit({ type: "resync" });
  await host.emit({
    type: "conversation-turn",
    conversationId: design.id,
    turn: { ...running, status: "completed" },
    conversation: { updatedAt: 3 },
  });
  await host.respond({ ...design, title: "Renamed before reconnect" });

  assert.equal(host.designTitle(), "Renamed before reconnect");
  assert.equal(host.artboard().disabled, false);
});

test("Design resync cannot reopen a canvas archived while the read was pending", async (t) => {
  const host = await fixture(t);
  await host.respond(design);
  assert.equal(host.designTitle(), design.title);

  await host.emit({ type: "resync" });
  await host.emit({
    type: "conversation",
    conversation: { ...design, archived: true },
  });
  assert.equal(host.designTitle(), undefined);

  await host.respond(design);
  assert.equal(host.designTitle(), undefined);
});
