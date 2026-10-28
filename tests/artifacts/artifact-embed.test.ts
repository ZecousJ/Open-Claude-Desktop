import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../electron/app/app-context";
import { ArtifactShares } from "../../electron/artifacts/artifact-shares";
import { registerSharingHandlers } from "../../electron/ipc/sharing";
import { requestJson } from "../../electron/sub2api/http";
import {
  embedCode,
  embedDomainsOf,
  invalidEmbedDomains,
  parseArtifactEmbed,
  parseSharingStatus,
} from "../../shared/sharing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { embedCodeState } from "../../src/artifacts/PublishArtifactModal";
import {
  EmbedSettings,
  PublishArtifactContent,
} from "../../src/artifacts/PublishArtifactContent";
import { fail, MockSub2Api, ok } from "../support/sub2api-mock";

type Json = Record<string, unknown>;
const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const token = "E".repeat(43);

/** The sharing handlers over a Claudex service with one published artifact. */
async function desktop(t: TestContext) {
  const mock = new MockSub2Api({ users: [user] });
  await mock.start();
  t.after(() => mock.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-embed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const share = {
    id: 1,
    kind: "artifact",
    source_key: "k",
    title: "Card",
    status: "active",
    disabled_reason: "",
    created_at: now,
    snapshot_at: now,
    expires_at: null,
    path: `/s/${token}`,
    url: "",
  };
  const lists = new Map<string, string[]>();
  const embedOf = (id: string) => ({
    domains: lists.get(id) ?? [],
    url: "",
    path: `/s/${token}/embed`,
  });
  mock.route("GET", "/api/v1/claudex/sharing/status", () =>
    ok({ enabled: true, artifacts: true, artifact_embeds: true }),
  );
  mock.route("GET", "/api/v1/claudex/shares", () =>
    ok({ items: [share], total: 1, page: 1, page_size: 100, pages: 1 }),
  );
  mock.route("GET", "/api/v1/claudex/shares/:id/embed", (request) =>
    ok(embedOf(request.params.id)),
  );
  mock.route("PUT", "/api/v1/claudex/shares/:id/embed", (request) => {
    const domains = (request.body.domains as string[]) ?? [];
    if (domains.includes("refused.example.com"))
      return fail(400, "Invalid", "CLAUDEX_EMBED_DOMAINS_INVALID", {
        domain: "refused.example.com",
      });
    lists.set(request.params.id, domains);
    return ok(embedOf(request.params.id));
  });
  const login = (await requestJson(fetch, `${mock.url}/api/v1/auth/login`, {
    method: "POST",
    body: { email: user.email, password: user.password },
  })) as Json;
  const ctx = {
    store: { root, conversations: [] },
    remote: {
      accounts: { baseUrl: mock.url },
      session: {
        authorized: <T>(call: (token: string) => Promise<T>) =>
          call(String(login.access_token)),
      },
    },
    artifactShares: new ArtifactShares(root),
    services: {},
    push() {},
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSharingHandlers((name, fn) => handlers.set(name, fn), ctx);
  const call = (name: string, ...args: unknown[]) =>
    handlers.get(name)!(...args);
  return { call, lists, mock };
}

test("Get embed code reads and saves a published artifact's allowed domains", async (t) => {
  const { call, lists, mock } = await desktop(t);
  assert.equal((await call("sharingStatus")).embeds, true);
  const embed = await call("artifactEmbed", "1");
  assert.deepEqual(embed, { url: `${mock.url}/s/${token}/embed`, domains: [] });
  const saved = await call("setArtifactEmbedDomains", "1", [
    " WWW.Example.com",
    "*.blog.io",
  ]);
  assert.deepEqual(saved.domains, ["www.example.com", "*.blog.io"]);
  // The dialog's check runs here too; the service's refusal reads the same.
  await assert.rejects(
    call("setArtifactEmbedDomains", "1", ["nope"]),
    /nope is not a valid domain/,
  );
  await assert.rejects(
    call("setArtifactEmbedDomains", "1", ["refused.example.com"]),
    /refused\.example\.com is not a valid domain/,
  );
  assert.deepEqual(lists.get("1"), ["www.example.com", "*.blog.io"]);
  await assert.rejects(call("artifactEmbed", "2"), /no longer exists/);
});

test("embed helpers: the live domain check and the iframe code", () => {
  assert.deepEqual(embedDomainsOf(" A.com, ,www.Example.com ,"), [
    "a.com",
    "www.example.com",
  ]);
  assert.deepEqual(
    invalidEmbedDomains(["www.example.com", "*.example.com", "example", "x.c"]),
    ["example", "x.c"],
  );
  assert.equal(
    embedCode("https://s.example/s/abc/embed", 'Tom & "Jerry"'),
    '<iframe src="https://s.example/s/abc/embed" title="Tom &amp; &quot;Jerry&quot;" width="100%" height="600" frameborder="0" allow="clipboard-write" allowfullscreen></iframe>',
  );
  assert.match(
    embedCode("https://s.example/e", ""),
    /title="Claudex Artifact"/,
  );
  assert.equal(
    parseArtifactEmbed({ path: "/s/x/embed" }, "https://a.example"),
    undefined,
  );
  assert.equal(
    parseSharingStatus({
      enabled: true,
      artifacts: true,
      artifact_embeds: true,
      blocked: true,
    })?.embeds,
    undefined,
  );
});

test("Get embed code shows under a published link only where the service serves embeds", () => {
  const share = {
    id: "7",
    kind: "artifact" as const,
    sourceKey: "card",
    title: "Card",
    url: `https://share.example.test/s/${token}`,
    createdAt: 1,
    snapshotAt: 1,
    status: "active" as const,
  };
  const render = (extra: Json) =>
    renderToStaticMarkup(
      createElement(PublishArtifactContent, {
        share: null,
        liveLinks: 0,
        busy: false,
        copied: false,
        title: "Card",
        onPublish() {},
        onCopy() {},
        onOpenLink() {},
        onUnpublish() {},
        onUsagePolicy() {},
        ...extra,
      }),
    );
  const onEmbed = () => {};
  assert.match(
    render({ share, onEmbed }),
    /class="publish-artifact-embed-entry"><button type="button"><svg[^>]*>.*<\/svg>Get embed code<\/button>/,
  );
  assert.doesNotMatch(render({ share }), /Get embed code/);
  assert.doesNotMatch(render({ onEmbed }), /Get embed code/);
  assert.doesNotMatch(
    render({ share: { ...share, status: "disabled" }, onEmbed }),
    /Get embed code/,
  );
  const settings = renderToStaticMarkup(
    createElement(EmbedSettings, {
      shareId: "7",
      title: "Card",
      onBack() {},
      onError() {},
    }),
  );
  assert.match(
    settings,
    /<label for="publish-embed-domains">Allowed domains<\/label>/,
  );
  assert.match(
    settings,
    /Only these domains can embed this artifact\. Separate with commas\./,
  );
  assert.match(settings, /placeholder="www\.example\.com, www\.myblog\.com"/);
  assert.match(
    settings,
    /Embed code<\/label><textarea id="publish-embed-code" rows="5" readOnly=""/,
  );
  assert.match(settings, /Cancel<\/button>/);
  assert.match(settings, /Copy code<\/button>/);
  assert.doesNotMatch(settings, /Saved/);
});

test("Allowed domains: errors show after leaving the field, a save only when changed and valid", () => {
  // Typing: no error yet, nothing saved.
  assert.deepEqual(embedCodeState("www.example.com, bad", [], true), {
    error: "",
    save: false,
  });
  // Left the field with an invalid domain: the live message, nothing saved.
  assert.deepEqual(embedCodeState("www.example.com, bad", [], false), {
    error: "bad is not a valid domain",
    save: false,
  });
  assert.deepEqual(embedCodeState("x, y, z.com", [], false), {
    error: "x and y are not valid domains",
    save: false,
  });
  // Changed and valid: saved; the same set in another order is not a change.
  assert.deepEqual(embedCodeState("b.com, a.com", [], false), {
    error: "",
    save: true,
  });
  assert.deepEqual(embedCodeState("b.com, a.com", ["a.com", "b.com"], false), {
    error: "",
    save: false,
  });
});
