import test from "node:test";
import assert from "node:assert/strict";
import {
  readStaticArtifact,
  staticArtifactDocument,
  parseStaticArtifactSelection,
} from "../electron/official-ui/preview/static-content";
import { conversationSnippets } from "../electron/official-ui/api/artifacts";
import type { Conversation } from "../shared/types";
import type { AdapterContext } from "../electron/official-ui/api/context";
function fixture(language = "html") {
  let activation = 1;
  const c: Conversation = {
    id: "chat",
    title: "Static example",
    mode: "chat",
    model: "inert",
    providerId: "inert",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "inert",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [
          {
            id: "answer",
            type: "agentMessage",
            text: "```" + language + "\n<h1>Self-authored</h1>\n```",
          },
        ],
      },
    ],
  };
  let onRead = () => {};
  const ctx = {
    account: () => ({ id: "A" }),
    sessionIdentity: () => activation,
    isCurrent: () => true,
    loadConversation: async () => {
      onRead();
      return c;
    },
  } as unknown as AdapterContext;
  const row = conversationSnippets("A", c)[0];
  return {
    c,
    ctx,
    selection: {
      conversationId: c.id,
      artifactId: row.artifact_uuid,
      versionId: row.uuid,
    },
    retire: () => activation++,
    onRead: (fn: () => void) => (onRead = fn),
  };
}
test("exact owned snippet/version yields CSP-wrapped static HTML without file lookup", async () => {
  const f = fixture();
  const result = await readStaticArtifact(f.ctx, f.selection);
  assert.ok(result.document.includes("<h1>Self-authored</h1>"));
  assert.ok(result.document.includes("script-src 'none'"));
  assert.equal(result.current(), true);
  f.retire();
  assert.equal(result.current(), false);
});
test("replacement activation during source read and wrong version reject", async () => {
  const f = fixture();
  f.onRead(f.retire);
  await assert.rejects(
    readStaticArtifact(f.ctx, f.selection),
    /account changed/,
  );
  const g = fixture();
  await assert.rejects(
    readStaticArtifact(g.ctx, {
      ...g.selection,
      versionId: "11111111-1111-4111-8111-111111111111",
    }),
    /version/,
  );
});
test("incognito/shared-other-owner and non-chat sources are not exposed", async () => {
  for (const change of ["private", "shared", "code"]) {
    const f = fixture();
    if (change === "private") f.c.incognito = true;
    else if (change === "code") f.c.mode = "code";
    else
      f.c.sessionAuthors = {
        ownerAccountUuid: "other",
        viewerAccountUuid: "A",
      } as Conversation["sessionAuthors"];
    await assert.rejects(readStaticArtifact(f.ctx, f.selection), /version/);
  }
});
test("renderer content/path/extra fields invalid; only known static types accepted", async () => {
  const f = fixture();
  assert.throws(() =>
    parseStaticArtifactSelection({ ...f.selection, path: "/inert" }),
  );
  assert.throws(() =>
    parseStaticArtifactSelection({
      ...f.selection,
      versionId: [f.selection.versionId],
    }),
  );
  for (const language of ["react", "mermaid", "svg", "js"]) {
    const g = fixture(language);
    await assert.rejects(
      readStaticArtifact(g.ctx, g.selection),
      /interactive renderer/,
    );
  }
});
test("plaintext and markdown remain escaped source, content bounded, outer fixed shell contains no artifact", () => {
  for (const type of ["text/plain", "text/markdown"]) {
    const result = staticArtifactDocument("<script>inert()</script>", type);
    assert.ok(result.includes("&lt;script&gt;"));
    assert.ok(!result.includes("<script>inert"));
  }
  assert.throws(() => staticArtifactDocument("a".repeat(1048577), "text/html"));
  assert.throws(() => staticArtifactDocument("\0", "text/html"));
});
test("empty activation identity fails before source load while opaque and zero remain valid", async () => {
  const f = fixture();
  let reads = 0;
  const load = f.ctx.loadConversation;
  f.ctx.loadConversation = async (id) => {
    reads++;
    return load(id);
  };
  f.ctx.sessionIdentity = () => "";
  await assert.rejects(
    readStaticArtifact(f.ctx, f.selection),
    /active account/,
  );
  assert.equal(reads, 0);
  for (const identity of [0, {}]) {
    f.ctx.sessionIdentity = () => identity;
    await readStaticArtifact(f.ctx, f.selection);
  }
  assert.equal(reads, 2);
});
test("same-account state root replacement during source await invalidates the preview", async () => {
  const f = fixture();
  let root = "/inert/A";
  f.ctx.stateDirectory = () => root;
  f.onRead(() => {
    root = "/inert/other";
  });
  await assert.rejects(
    readStaticArtifact(f.ctx, f.selection),
    /account changed/,
  );
});
test("declared policies allow inline CSS only, not external styles/imports/font/image/connect sources", async () => {
  const { staticPreviewShellCsp, staticPreviewShell } =
    await import("../electron/official-ui/preview/static-documents");
  const doc = staticArtifactDocument(
    '<style>@import "https://inert.invalid/style";p{background:url(https://inert.invalid/image)}</style><p>Inert CSS sample</p>',
    "text/html",
  );
  // Source-policy assertions, not a claim that jsdom enforces CSP or that a browser rendered it.
  for (const policy of [staticPreviewShellCsp, doc]) {
    assert.ok(policy.includes("style-src 'unsafe-inline'"));
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(policy.includes("script-src 'none'"));
    assert.ok(policy.includes("img-src 'none'"));
    assert.ok(policy.includes("connect-src 'none'"));
  }
  const styleDirective = staticPreviewShellCsp
    .split(";")
    .find((x) => x.trim().startsWith("style-src"))!
    .trim();
  assert.equal(styleDirective, "style-src 'unsafe-inline'");
  assert.ok(!staticPreviewShell.includes("Inert CSS sample"));
});
