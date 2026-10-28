import assert from "node:assert/strict";
import test from "node:test";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import { conversationMarkdown as desktopMarkdown } from "../../electron/conversations/data-export";
import {
  conversationMarkdown,
  dispositionName,
  safeFileName,
} from "../../src-web/bridge/browser-methods";
import { platformFromHint } from "../../src-web/bridge/state";
import { json, signedInBridge } from "./web-bridge-fakes.test.ts";

const policy = (patch: Partial<ClientPolicy> = {}): ClientPolicy => ({
  ...structuredClone(openPolicy),
  ...patch,
});

const sample = {
  id: "c1",
  title: "Trip / plans",
  turns: [
    {
      id: "t1",
      prompt: "Where to?",
      items: [
        { id: "i1", type: "reasoning", text: "hidden" },
        { id: "i2", type: "agentMessage", text: "Lisbon." },
        { id: "i3", type: "agentMessage", text: "Or Porto." },
      ],
    },
    { id: "t2", prompt: "Why?", items: [] },
  ],
} as unknown as Conversation;

async function withPolicy(
  value: ClientPolicy,
  extra?: (m: string, a: unknown[]) => unknown,
) {
  return signedInBridge((method, args) =>
    method === "clientPolicy" ? value : extra?.(method, args),
  );
}

test("the Markdown export matches the desktop's", () => {
  assert.equal(conversationMarkdown(sample), desktopMarkdown(sample));
});

test("platforms come from the browser, file names lose folders", () => {
  assert.equal(platformFromHint("macOS"), "darwin");
  assert.equal(platformFromHint("MacIntel"), "darwin");
  assert.equal(platformFromHint("Windows"), "win32");
  assert.equal(platformFromHint("Linux x86_64"), "linux");
  assert.equal(safeFileName("../../etc/pass:wd", "x"), "pass_wd");
  assert.equal(safeFileName("", "fallback.txt"), "fallback.txt");
  assert.equal(
    dispositionName(`attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.zip`),
    "résumé.zip",
  );
  assert.equal(dispositionName('attachment; filename="a b.md"'), "a b.md");
});

test("copy, fonts and window buttons", async () => {
  const { bridge, tab } = await signedInBridge();
  await bridge.api.copyText("hello");
  assert.deepEqual(tab.clipboard, ["hello"]);
  await bridge.api.copyImage("data:image/png;base64,aW1hZ2U=");
  assert.deepEqual(tab.clipboard, ["hello", "data:image/png;base64,aW1hZ2U="]);
  await bridge.api.windowAction("close");
});

test("links open in a new tab as the administrator allows", async () => {
  const { bridge, tab } = await withPolicy(
    policy({ externalLinks: false, trustedLinkDomains: ["docs.example.com"] }),
  );
  await bridge.api.openExternal("https://docs.example.com/a");
  assert.deepEqual(tab.tabs, ["https://docs.example.com/a"]);
  await assert.rejects(
    bridge.api.openExternal("https://other.example/"),
    /turned off external links/,
  );
  await assert.rejects(
    bridge.api.openExternal("javascript:alert(1)"),
    /Only HTTP\(S\) links/,
  );
  // With the policy cached, the tab opens during the click (a string, not a promise).
  const opened: unknown[] = [];
  tab.env.openTab = async (url) => {
    opened.push(url);
  };
  await bridge.api.openExternal("https://docs.example.com/b");
  assert.deepEqual(opened, ["https://docs.example.com/b"]);
});

test("the desktop download page opens only when published", async () => {
  const { bridge, tab } = await withPolicy(
    policy({ links: { learnMore: [], apps: "https://get.example/apps" } }),
  );
  await bridge.api.openUpdateDownload();
  assert.deepEqual(tab.tabs, ["https://get.example/apps"]);
  const none = await withPolicy(policy());
  await assert.rejects(
    none.bridge.api.openUpdateDownload(),
    /hasn't published a download page/,
  );
});

test("attachments: the picker follows the policy and files go to the runner", async () => {
  const added: unknown[][] = [];
  const { bridge, tab } = await withPolicy(
    policy({ attachments: { maxBytes: null, types: ["png", "txt"] } }),
    (method, args) => {
      if (method !== "addAttachmentData") return null;
      added.push(args);
      return {
        id: `a${added.length}`,
        name: args[0],
        path: "",
        kind: "text",
        size: 2,
      };
    },
  );
  // Nothing cached yet: every supported type is offered, the policy decides after.
  tab.files = [
    {
      name: "a.txt",
      size: 2,
      type: "text/plain",
      bytes: async () => new Uint8Array([104, 105]),
    },
  ];
  const first = await bridge.api.chooseAttachments();
  assert.equal(first.length, 1);
  assert.deepEqual(added[0], ["a.txt", new Uint8Array([104, 105])]);
  assert.match(tab.picks[0]!.accept, /\.md,/);
  await bridge.api.chooseAttachments();
  assert.equal(tab.picks[1]!.accept, ".png,.txt");
  tab.files = [
    { name: "x.exe", size: 2, type: "", bytes: async () => new Uint8Array(2) },
  ];
  await assert.rejects(bridge.api.chooseAttachments(), /can’t be attached/);
  tab.files = [];
  assert.deepEqual(await bridge.api.chooseAttachments(), []);
});

test("attachments turned off are refused before the picker opens", async () => {
  const { bridge, tab } = await withPolicy(
    policy({ attachments: { maxBytes: null, types: [] } }),
  );
  await bridge.api.clientPolicy().then((p) => (bridge.state.cachedPolicy = p));
  await assert.rejects(
    bridge.api.chooseAttachments(),
    /turned off attachments/,
  );
  assert.equal(tab.picks.length, 0);
});

test("exports download: Markdown from the conversation, the account archive from Go", async () => {
  const { bridge, tab } = await signedInBridge((method) =>
    method === "snapshot"
      ? { conversations: [sample], platform: "linux" }
      : null,
  );
  await bridge.api.snapshot();
  assert.equal(await bridge.api.exportConversation("c1"), "Trip _ plans.md");
  const saved = tab.downloads.at(-1)!;
  assert.equal(await saved.data.text(), desktopMarkdown(sample));
  tab.routes.unshift((request) => {
    const url = new URL(request.url, "https://claudex.example").pathname;
    if (url === "/api/v1/claudex/web/downloads/export")
      return new Response(new Uint8Array([80, 75]), {
        headers: {
          "Content-Disposition":
            'attachment; filename="claudex-export-2026-09-26.zip"',
        },
      });
    if (url === "/api/v1/claudex/web/downloads/conversations/gone.md")
      return json({ code: 404, message: "Conversation not found." }, 404);
    return undefined;
  });
  assert.equal(await bridge.api.exportData(), "claudex-export-2026-09-26.zip");
  const archive = tab.requests.at(-1)!;
  assert.equal(archive.headers.get("authorization"), "Bearer at-1");
  await assert.rejects(bridge.api.exportConversation("gone"), /not found/);
});

test("Code exports hosted JSON with metadata and the complete transcript, not a local ZIP or Markdown", async () => {
  const conversation = {
    ...sample,
    mode: "code",
    model: "test-model",
    updatedAt: 10,
    turns: sample.turns.map((turn) => ({ ...turn, createdAt: 1 })),
  } as Conversation;
  const { bridge, tab } = await signedInBridge((method) =>
    method === "snapshot"
      ? { conversations: [conversation], platform: "linux" }
      : null,
  );
  await bridge.api.snapshot();
  const filename = await bridge.api.exportConversation(conversation.id);
  assert.match(filename!, /^session-c1-\d+\.json$/);
  const saved = tab.downloads.at(-1)!;
  const payload = JSON.parse(await saved.data.text());
  assert.equal(payload.session.id, "c1");
  assert.equal(payload.session.session_context.model, "test-model");
  assert.equal(payload.session.title, sample.title);
  assert.equal(payload.messages.length, 5);
  assert.equal(payload.messages[1].item.type, "reasoning");
  assert.equal(payload.messages[2].item.text, "Lisbon.");
  assert.equal(saved.data.type, "application/json");
});

test("artifacts, generated files and research reports download", async () => {
  const { bridge, tab } = await signedInBridge((method, args) => {
    if (method === "readGeneratedFile") {
      assert.deepEqual(args, ["d1"]);
      return "AAEC";
    }
    if (method === "readResearchReport")
      return { title: "Tides", markdown: "# Tides" };
    return null;
  });
  assert.equal(
    await bridge.api.saveArtifact("dir/page.html", "<p>"),
    "page.html",
  );
  assert.equal(await tab.downloads.at(-1)!.data.text(), "<p>");
  assert.equal(
    await bridge.api.saveArtifactBytes("dir/report.docx", "UEs="),
    "report.docx",
  );
  assert.equal(await tab.downloads.at(-1)!.data.text(), "PK");
  assert.equal(
    tab.downloads.at(-1)!.data.type,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(await bridge.api.saveGeneratedFile("d1", "img.png"), "img.png");
  assert.deepEqual(
    new Uint8Array(await tab.downloads.at(-1)!.data.arrayBuffer()),
    new Uint8Array([0, 1, 2]),
  );
  assert.equal(await bridge.api.saveResearchReport("c", "t"), true);
  assert.equal(tab.downloads.at(-1)!.name, "Tides.md");
  assert.equal(
    await bridge.api.saveMcpResourceFile({
      name: "dir/report.pdf",
      mimeType: "application/pdf",
      base64: "JVBERg==",
    }),
    "report.pdf",
  );
  assert.equal(tab.downloads.at(-1)!.data.type, "application/pdf");
  assert.equal(await tab.downloads.at(-1)!.data.text(), "%PDF");
  await assert.rejects(
    bridge.api.saveMcpResourceFile({
      name: "bad",
      mimeType: "text/plain",
      base64: "bad%",
    }),
  );
});

test("share pages open from the account's hosted shares", async () => {
  const { bridge, tab } = await signedInBridge((method) =>
    method === "hostedShares"
      ? [
          { id: "s1", url: "https://claudex.example/s/abc", status: "active" },
          {
            id: "s2",
            url: "https://claudex.example/s/def",
            status: "disabled",
          },
          { id: "s3", url: "http://evil.example/s/x", status: "active" },
        ]
      : null,
  );
  await bridge.api.openShare("s1");
  assert.deepEqual(tab.tabs, ["https://claudex.example/s/abc"]);
  await assert.rejects(bridge.api.openShare("s2"), /no longer exists/);
  await assert.rejects(bridge.api.openShare("s3"), /Only secure links/);
});

test("the microphone is refused only when the site is blocked", async () => {
  const { bridge, tab } = await signedInBridge();
  assert.equal(await bridge.api.requestMicrophone(), true);
  tab.permission = "denied";
  assert.equal(await bridge.api.requestMicrophone(), false);
});
