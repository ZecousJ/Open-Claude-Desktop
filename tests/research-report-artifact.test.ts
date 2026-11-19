import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { z } from "zod";
import { artifactPublishingRoute } from "../electron/official-ui/api/artifact-publishing";
import { conversationRestMessages } from "../electron/official-ui/api/conversations";
import { RestCompletionTextStream } from "../electron/official-ui/api/rest-completion-stream";
import { conversationSnippets } from "../electron/official-ui/api/artifacts";
import { organizationUuid, type AdapterContext } from "../electron/official-ui/api/context";
import { researchReportArtifactIdentifier, researchReportVersions } from "../electron/official-ui/api/research-report-artifact";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";
import { conversationUpdate, deepCreate, loadRegistry } from "../electron/official-ui/api/timeline";
import type { ArtifactShareInput, Conversation, Turn } from "../shared/types";

const owner = "report-owner";
const org = organizationUuid(owner);
const original = "# Research\n\nOriginal résumé 中文.\n";
const edited = "# Research\n\nUpdated résumé 中文.\n\n```js\nconst checked = true;\n```\n";
const artifactBlock = z.object({
  id: z.string(), text: z.string(),
  displayContent: z.object({ content: z.object({ case: z.literal("file"), value: z.object({
    fileId: z.string(), artifactVersionUuid: z.string(), title: z.string(), fileType: z.string(),
    versionNumber: z.number(), command: z.number(),
  }) }) }),
});

function snapshot(markdown: string) {
  return { title: "Research report", markdown, bytes: Buffer.byteLength(markdown), sha256: createHash("sha256").update(markdown).digest("hex") };
}

function reportConversation() {
  const first: Turn = {
    id: "research-turn", prompt: "Research a topic", createdAt: 1000,
    status: "completed", items: [], attachments: [],
    research: {
      state: "done", startedAt: 1000, sourceCount: 0,
      report: { ...snapshot(original), path: "research/chat/research-turn.md" },
    },
  };
  const conversation: Conversation = {
    id: "11aeb042-5555-4000-8000-b05844072137", title: "Chat", mode: "chat",
    providerId: "provider", model: "model", createdAt: 999, updatedAt: 4000,
    pinned: false, archived: false, turns: [first],
  };
  const artifactId = researchReportArtifactIdentifier(org, conversation, first);
  assert.ok(artifactId);
  const edit = (id: string, createdAt: number, markdown: string): Turn => ({
    id, createdAt, prompt: "Revise this report", status: "completed", attachments: [],
    items: [
      { id: `${id}-report`, type: "agentMessage", text: `<research_report_revision>\n${markdown}\n</research_report_revision>` },
      { id: `${id}-summary`, type: "agentMessage", text: "I revised the report." },
    ],
    researchReportRevision: { ...snapshot(markdown), artifactId, sourceItemId: `${id}-report`, version: 2 },
  });
  conversation.turns.push(edit("active-edit", 2000, edited));
  conversation.savedBranches = [{
    id: "other-branch", providerId: "provider", model: "model", visited: 3000,
    turns: [structuredClone(first), edit("branch-edit", 3000, "# Alternate version\n")],
  }];
  return conversation;
}

test("Research reports use the original FileDisplay version protocol and saved catalog", () => {
  const conversation = reportConversation();
  const update = inAdapterScope(newAdapterScope(owner), () => conversationUpdate(
    { ...conversation, id: "public-alias" }, false, { org, conversationId: conversation.id },
  ));
  assert.ok(update.contentBlocks && update.messages);
  const registry = loadRegistry("build/official-ui/data/conversation-protocol.json");
  const schema = registry.getMessage("anthropic.bard.api.v1alpha.ConversationUpdate");
  assert.ok(schema);
  const decoded = fromBinary(schema, toBinary(schema, deepCreate(schema, update)));
  const { contentBlocks } = z.object({ contentBlocks: z.array(z.unknown()) }).parse(decoded);
  const wireFiles = contentBlocks.map(block => artifactBlock.safeParse(block)).flatMap(result => result.success ? [result.data] : []);
  const rows = conversationSnippets(owner, conversation, undefined, true);
  const versions = researchReportVersions(org, conversation);
  assert.deepEqual(versions.map(version => version.markdown), [original, edited]);
  assert.equal(rows.length, 3);
  assert.equal(wireFiles.length, rows.length);
  for (const version of versions) {
    const block = wireFiles.find(block => block.id === `${version.versionUuid}:artifact`);
    assert.ok(block);
    const file = block.displayContent.content;
    assert.equal(file.case, "file");
    assert.deepEqual(file.value, {
      fileId: version.artifactIdentifier, artifactVersionUuid: version.versionUuid,
      title: version.title, fileType: "text/markdown", versionNumber: version.version,
      command: version.version === 1 ? 1 : 2,
    });
    assert.equal(block.text, version.markdown);
    assert.equal(rows.find(row => row.uuid === version.versionUuid)?.result_state, version.markdown);
  }
  assert.ok(!update.contentBlocks.some(block => block.text?.includes("<research_report_revision>")));
  assert.ok(update.contentBlocks.some(block => block.text === "I revised the report."));
  assert.ok(update.messages.every(message => message.attachments.length === 0));
  assert.deepEqual(conversationSnippets(owner, conversation), []);
});

test("REST keeps the Research task and exact saved report through completion and reload", () => {
  const conversation = reportConversation();
  const turn = conversation.turns[0];
  turn.items.push({ id: "plan", type: "dynamicToolCall", tool: "research_plan", status: "completed" });
  const report = researchReportVersions(org, conversation)[0];
  assert.ok(report);
  const stream = new RestCompletionTextStream();
  const output = { organization: org, conversationId: conversation.id, conversation };
  const running: Turn = { ...turn, status: "inProgress", research: { state: "writing", startedAt: 1000, sourceCount: 0 } };
  running.items = [{ id: "provisional", type: "reasoning", text: "working" }];
  stream.update(running, "human", "assistant", "model", output);
  running.items[0].text = "rewritten after the search";
  stream.update(running, "human", "assistant", "model", output);
  stream.update(turn, "human", "assistant", "model", { ...output, researchArtifact: report });
  assert.ok(stream.done);
  assert.equal(stream.events.at(-1)?.event, "message_stop");
  const starts = stream.events.filter(event => event.event === "content_block_start").map(event => event.data.content_block);
  const tool = z.object({ name: z.string(), type: z.string() });
  const artifact = starts.map(block => tool.passthrough().parse(block)).find(block => block.name === "artifacts");
  assert.equal(z.object({ content: z.string() }).parse(artifact?.input).content, original);
  assert.deepEqual(starts.map(block => tool.parse(block).name), [
    "launch_extended_search_task", "launch_extended_search_task", "artifacts", "artifacts",
  ]);
  const history = inAdapterScope(newAdapterScope(owner), () => conversationRestMessages(conversation, org));
  const initial = history.messages.flatMap(message => message.content).find(block => block.type === "tool_use" && block.name === "artifacts");
  assert.equal(initial?.input.version_uuid, report.versionUuid);
  assert.equal(initial?.input.content, original);
});

test("unverified report bytes and a revision without its branch origin are unavailable", () => {
  const conversation = reportConversation();
  const origin = conversation.turns[0].research?.report;
  assert.ok(origin);
  origin.markdown = original.replace("Original", "Tampered");
  assert.deepEqual(researchReportVersions(org, conversation), []);
  assert.deepEqual(researchReportVersions(org, conversation, conversation.turns.slice(1)), []);
  const update = inAdapterScope(newAdapterScope(owner), () => conversationUpdate(
    { ...conversation, savedBranches: [] }, false, { org },
  ));
  assert.ok(update.contentBlocks);
  assert.ok(!update.contentBlocks.some(block => block.displayContent?.content?.case === "file"));
  assert.ok(!update.contentBlocks.some(block => block.text === origin.markdown));
});

test("Research sharing resolves the owned saved version and publishes only its stored bytes", async () => {
  const conversation = reportConversation();
  conversation.sessionAuthors = { ownerAccountUuid: owner, viewerAccountUuid: owner };
  const row = conversationSnippets(owner, conversation, undefined, true).find(row => row.result_state === edited);
  assert.ok(row);
  let account = owner;
  const published: ArtifactShareInput[] = [];
  const publication = {
    closed: false, unpublished: new Set(), status: async () => ({ artifacts: true, blocked: false }),
    async publishArtifact(input: ArtifactShareInput) {
      published.push(input);
      return { status: "active", id: "share-id", url: "https://example.test/public/share-id" };
    },
  };
  const ctx = {
    account: () => ({ id: account }), sessionIdentity: () => 1,
    artifactPublishing: () => publication, log: () => {},
    loadConversation: async (id: string) => id === conversation.id ? conversation : undefined,
  } as unknown as AdapterContext;
  async function post(path: string, body: object) {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST" }) as unknown as IncomingMessage;
    let status = 0;
    let data: unknown;
    const res = {
      writeHead(code: number) { status = code; },
      end(body: string) { data = JSON.parse(body); },
    } as unknown as ServerResponse;
    assert.equal(await artifactPublishingRoute(req, res, new URL(path, "http://localhost"), ctx), true);
    return { status, data };
  }
  const share = `/api/organizations/${org}/chat_conversations/${conversation.id}/research_reports/share`;
  const publish = `/api/organizations/${org}/publish_artifact`;
  const request = { artifact_identifier: row.artifact_identifier, version_uuid: row.uuid };
  assert.deepEqual(await post(share, request), { status: 200, data: { outcome: "use_classic" } });
  const branch = conversationSnippets(owner, conversation, undefined, true).find(candidate => candidate.result_state === "# Alternate version\n");
  assert.ok(branch);
  assert.deepEqual(await post(share, { ...request, version_uuid: branch.uuid }), { status: 200, data: { outcome: "use_classic" } });
  assert.equal((await post(share, { ...request, version_uuid: "11aeb042-5555-4000-8000-b05844072137" })).status, 404);
  const draft = {
    conversation_uuid: conversation.id, message_uuid: row.message_uuid,
    artifact_identifier: row.artifact_identifier, artifact_version_uuid: row.uuid, content: edited,
  };
  assert.equal((await post(publish, { ...draft, content: "Browser replacement" })).status, 409);
  assert.equal(published.length, 0);
  assert.equal((await post(publish, draft)).status, 200);
  assert.equal(published[0]?.content, edited);
  assert.equal(published[0]?.versionId, row.uuid);
  account = "foreign-account";
  const foreignOrg = organizationUuid(account);
  assert.equal((await post(share.replace(org, foreignOrg), request)).status, 404);
  assert.equal((await post(publish.replace(org, foreignOrg), draft)).status, 404);
  assert.equal(published.length, 1);
});
