import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import {
  ComputerUseActivity,
  computerUseItems,
} from "../../src/cowork/ComputerUseActivity";
import { ComputerUseActivityDetail } from "../../src/cowork/ComputerUseActivityDetail";
import { resetComputerUseForTests } from "../../src/computer-use/useComputerUse";

const session = (status = "inProgress"): Conversation =>
  ({
    id: "c1",
    mode: "cowork",
    turns: [
      {
        id: "t1",
        status,
        items: [
          { id: "other", type: "mcpToolCall", server: "browser" },
          {
            id: "shot",
            type: "mcpToolCall",
            server: "computer-use",
            tool: "get_app_state",
            result: {
              content: [{ type: "image", mimeType: "image/png", data: "UE5H" }],
            },
          },
        ],
      },
    ],
  }) as Conversation;

test("the activity card keeps historical screenshots and opens details, not Stop", () => {
  resetComputerUseForTests();
  const conversation = session();
  assert.deepEqual(
    computerUseItems(conversation).map((item) => item.id),
    ["shot"],
  );
  const html = renderToStaticMarkup(
    createElement(ComputerUseActivity, { conversation }),
  );
  assert.match(html, /aria-label="Computer use"/);
  assert.match(html, /aria-label="Open computer use activity"/);
  assert.match(html, /data:image\/png;base64,UE5H/);
  assert.doesNotMatch(html, /progress-live|Stop/);
  const collapsed = renderToStaticMarkup(
    createElement(ComputerUseActivity, { conversation: session("completed") }),
  );
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /<img/);
  assert.equal(
    renderToStaticMarkup(
      createElement(ComputerUseActivity, {
        conversation: { ...conversation, turns: [] },
      }),
    ),
    "",
  );
});

test("live computer use is scoped to the task and shows mode and target", () => {
  resetComputerUseForTests({
    activity: {
      conversationId: "c1",
      mode: "fullControl",
      app: { id: "TextEdit", name: "TextEdit", platform: "darwin" },
      startedAt: 0,
    },
  } as Parameters<typeof resetComputerUseForTests>[0]);
  const html = renderToStaticMarkup(
    createElement(ComputerUseActivity, { conversation: session() }),
  );
  assert.match(html, /progress-live[^>]*>Live/);
  assert.match(html, /Full control · TextEdit/);
  const other = renderToStaticMarkup(
    createElement(ComputerUseActivity, {
      conversation: { ...session(), id: "c2", turns: [] },
    }),
  );
  assert.equal(other, "");
  resetComputerUseForTests();
});

test("computer activity details show the frame and tool history", () => {
  const html = renderToStaticMarkup(
    createElement(ComputerUseActivityDetail, {
      items: computerUseItems(session()),
      source: "data:image/png;base64,UE5H",
      onClose() {},
    }),
  );
  assert.match(html, /Computer use/);
  assert.match(html, /data:image\/png;base64,UE5H/);
  assert.match(html, /cu-tool/);
});
