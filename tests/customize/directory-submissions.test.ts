import test from "node:test";
import assert from "node:assert/strict";
import { DirectorySubmissions } from "../../electron/connectors/directory-submissions";
import {
  directorySubmissionReady,
  type DirectorySubmissionInput,
} from "../../shared/directory-submissions";
import { readFileSync } from "node:fs";
import { directorySubmissionInput } from "../../shared/directory-submissions-input";
import { readSource } from "../support/read-source";

const input: DirectorySubmissionInput = {
  kind: "plugin",
  name: "Example",
  slug: "example",
  url: "https://example.com/plugin",
  description: "Example plugin",
  examples: "Read docs",
  email: "me@example.com",
  license: "MIT",
  termsAcknowledged: true,
  toolsVerified: false,
  tools: [],
};

test("directory submissions use the signed-in Claudex service", async () => {
  const rows: any[] = [];
  const store = new DirectorySubmissions(async (route, init) => {
    const body = init?.body as
      { input: DirectorySubmissionInput; submit: boolean } | undefined;
    if (route === "/claudex/directory/submissions" && !init) return rows;
    if (init?.method === "POST") {
      const row = {
        ...body!.input,
        id: "one",
        status: body!.submit ? "submitted" : "draft",
        reviewerNote: "",
        updatedAt: 1,
      };
      rows.unshift(row);
      return row;
    }
    if (init?.method === "PUT") {
      Object.assign(rows[0], body!.input, { status: "submitted" });
      return rows[0];
    }
    if (init?.method === "DELETE") {
      rows.splice(0);
      return true;
    }
    throw new Error("unexpected request");
  });
  const draft = await store.save(input, false);
  assert.equal(draft.status, "draft");
  const submitted = await store.save(
    { ...input, id: draft.id, description: "Updated" },
    true,
  );
  assert.equal(submitted.status, "submitted");
  assert.equal((await store.list()).length, 1);
  await store.delete(draft.id);
  assert.deepEqual(await store.list(), []);
});

test("directory submission readiness requires consent, HTTPS, identity and verified MCP tools", () => {
  assert.equal(directorySubmissionReady(input), true);
  for (const patch of [
    { termsAcknowledged: false },
    { url: "http://example.com" },
    { slug: "../bad" },
    { name: "" },
    { email: "" },
  ])
    assert.equal(directorySubmissionReady({ ...input, ...patch }), false);
  const mcp = { ...input, kind: "mcp" as const };
  assert.equal(directorySubmissionReady(mcp), false);
  assert.equal(
    directorySubmissionReady({ ...mcp, toolsVerified: true, tools: ["read"] }),
    true,
  );
});

test("directory service preserves review feedback and uses the approved directory endpoint", async () => {
  const reviewed = {
    ...input,
    id: "one",
    status: "rejected",
    reviewerNote: "Please include examples.",
    updatedAt: 2,
  };
  const approved = [
    {
      id: "two",
      kind: "plugin",
      name: "Approved",
      description: "Reviewed",
      url: input.url,
      added: "2026-10-15",
    },
  ];
  const routes: string[] = [];
  const service = new DirectorySubmissions(async (route) => {
    routes.push(route);
    return route === "/claudex/directory" ? approved : [reviewed];
  });
  assert.equal((await service.list())[0].reviewerNote, reviewed.reviewerNote);
  assert.deepEqual(await service.directory(), approved);
  assert.deepEqual(routes, [
    "/claudex/directory/submissions",
    "/claudex/directory",
  ]);
});

test("directory submission failures propagate instead of saving locally", async () => {
  const service = new DirectorySubmissions(async () => {
    throw new Error("service offline");
  });
  await assert.rejects(service.save(input, true), /service offline/);
  await assert.rejects(service.list(), /service offline/);
  await assert.rejects(service.delete("one"), /service offline/);
});

test("approved connector metadata survives submission without inventing authentication or authorship", async () => {
  const metadata = {
    author: "Example team",
    supportUrl: "https://example.com/help",
    documentationUrl: "https://example.com/docs",
    isAuthless: false,
  };
  const submitted = directorySubmissionInput.parse({ ...input, ...metadata });
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(metadata).map((key) => [
        key,
        submitted[key as keyof typeof metadata],
      ]),
    ),
    metadata,
  );
  assert.equal(
    directorySubmissionInput.safeParse({
      ...input,
      supportUrl: "javascript:alert(1)",
    }).success,
    false,
  );
  const entry = { ...submitted, id: "server", added: "2026-10-14" };
  const service = new DirectorySubmissions(async () => [entry]);
  assert.deepEqual((await service.directory())[0], entry);
  assert.equal(directorySubmissionInput.parse(input).isAuthless, undefined);
});

test("approved connectors use the current Discover surface and directory feeds stay lazy", () => {
  const source = readSource("src/collections/customize/CustomizePage.tsx");
  assert.match(
    source,
    /lazyPiece\(\s*\(\) => import\("\.\/ServiceDirectory"\)/,
  );
  assert.match(source, /tab === "connectors" && view === "discover"/);
  assert.match(source, /<CustomizeConnectors\s+settings=\{settings\}/);
});
