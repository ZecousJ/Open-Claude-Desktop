import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { conversationTexts, scanSecrets } from "../../shared/secret-scan";
import { ConversationShareView } from "../../src/conversation/ConversationShareDialog";
import type { SharingStatus } from "../../shared/sharing-api";

test("credentials that look real are found; ordinary text and code are not", () => {
  assert.deepEqual(
    scanSecrets(["export KEY=sk-ant-api03-abcdefghijklmnop12345678"]),
    ["api_key"],
  );
  assert.deepEqual(
    scanSecrets([
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "-----BEGIN RSA PRIVATE KEY-----",
      "AKIAABCDEFGHIJKLMNOP",
    ]).sort(),
    ["aws_access_key", "github_token", "private_key"],
  );
  assert.deepEqual(
    scanSecrets([
      "const risk = skill + sk",
      "sk-short",
      "Please rotate your keys regularly.",
    ]),
    [],
  );
});

test("a session's prompts, replies, commands and outputs are all looked through", () => {
  const texts = conversationTexts({
    turns: [
      {
        prompt: "deploy",
        items: [
          { id: "1", type: "agentMessage", text: "done" },
          {
            id: "2",
            type: "commandExecution",
            command: "env",
            aggregatedOutput: "X=1",
          },
          {
            id: "3",
            type: "dynamicToolCall",
            arguments: { token: "xoxb-1234567890-abcdef" },
            contentItems: [{ type: "inputText", text: "ok" }],
          },
        ],
      },
    ] as never,
  });
  assert.ok(texts.includes("deploy") && texts.includes("env"));
  assert.deepEqual(scanSecrets(texts), ["slack_token"]);
});

test("the share dialog warns about credentials, and still lets the session be shared", () => {
  const status = { conversations: true, blocked: false } as SharingStatus;
  const html = (secrets: boolean) =>
    renderToStaticMarkup(
      createElement(ConversationShareView, {
        conversation: { id: "c", title: "T", mode: "code" } as never,
        status,
        state: {
          share: null,
          busy: false,
          confirmStop: false,
          copied: false,
          repository: false,
          secrets,
        },
        onPublic() {},
        onPrivate() {},
        onCopy() {},
        onUpdate() {},
        onUsagePolicy() {},
      }),
    );
  assert.match(html(true), /This session may include secure credentials\./);
  assert.doesNotMatch(html(false), /secure credentials/);
  assert.doesNotMatch(html(true), /aria-disabled="true"[^>]*>.*Public/);
});
