import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Engine } from "../../electron/engine/engine";
import { turnInput } from "../../electron/engine/engine-support";
import { Store } from "../../electron/store/store";
import {
  isLengthLimitError,
  lengthLimitMessage,
  reconnectAttempt,
  isToolUseLimitError,
} from "../../shared/turn-errors";
import type { Conversation, Turn } from "../../shared/types";
import { TurnOutcome } from "../../src/transcript/TurnOutcome";
import { showsJumpToLatest } from "../../src/transcript/useTranscriptScroll";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";
import { preloadBrowserToolView } from "../../src/transcript/tools/McpToolView";

before(async () => {
  await preloadCodeTurnError();
  await preloadBrowserToolView();
});

function turn(extra: Partial<Turn>): Turn {
  return {
    id: "t",
    prompt: "Hello",
    attachments: [],
    items: [],
    status: "completed",
    createdAt: 1,
    ...extra,
  };
}
const outcome = (
  value: Turn,
  latest = true,
  extra: Partial<Parameters<typeof TurnOutcome>[0]> = {},
) =>
  renderToStaticMarkup(
    createElement(TurnOutcome, {
      turn: value,
      latest,
      busy: false,
      onRetry() {},
      onContinue() {},
      onEditPrompt() {},
      ...extra,
    }),
  );

test("the output limit is recognised from the gateway and Responses wording", () => {
  assert(isLengthLimitError(`stream error: ${lengthLimitMessage}`));
  assert(isLengthLimitError("Incomplete response: max_output_tokens"));
  assert(isLengthLimitError("max_tokens"));
  assert(isToolUseLimitError("tool_use_limit"));
  assert(isToolUseLimitError("maximum_tool_calls"));
  assert(!isToolUseLimitError("tool_calls"));
  assert(!isToolUseLimitError(undefined));
  assert(!isLengthLimitError("HTTP 502"));
  assert(!isLengthLimitError(undefined));
  assert.equal(reconnectAttempt("Reconnecting... 2/5"), "2/5");
  assert.equal(reconnectAttempt("stream disconnected"), undefined);
});

test("limit notices use the neutral frame and conditional Max effort guidance", () => {
  const length = turn({ status: "failed", stopReason: "length" });
  const guidance =
    "Max effort uses your limits faster than High. Consider a lower effort setting.";
  const max = outcome(length, true, {
    effort: "max",
    effortRecommended: false,
  });
  assert(max.includes(guidance));
  assert.match(max, /data-testid="message-warning"/);
  assert.match(max, /class="reply-banner-action"/);
  assert.doesNotMatch(max, /usage-banner|class="primary"/);
  assert(
    !outcome(length, true, { effort: "max", effortRecommended: true }).includes(
      guidance,
    ),
  );
  assert(!outcome(length, true, { effort: "high" }).includes(guidance));
  const tool = turn({ status: "failed", stopReason: "tool_use_limit" });
  assert.match(
    outcome(tool),
    /Claudex reached its tool-use limit for this turn\./,
  );
  assert.match(outcome(tool), />Continue</);
  assert.doesNotMatch(outcome(tool, false), /<button/);
  assert(!outcome(tool, true, { effort: "max" }).includes(guidance));
});

test("failed, limited, stopped and reconnecting turns say what happened", () => {
  const failed = outcome(turn({ status: "failed", error: "HTTP 502" }));
  // The reason in the original's words and its buttons sit in the
  // conversation; the engine's own text never shows.
  assert.match(
    failed,
    /Claudex is temporarily unavailable\. Try again in a moment\./,
  );
  assert.match(failed, />Try again</);
  assert.match(failed, />Continue</);
  assert.doesNotMatch(failed, /HTTP 502/);
  // An older failed reply tells its reason without buttons.
  assert.doesNotMatch(
    outcome(turn({ status: "failed", error: "HTTP 502" }), false),
    /<button/,
  );
  // While another response is being written the buttons wait.
  const waiting = outcome(turn({ status: "failed" }), true, { busy: true });
  assert.match(waiting, /aria-disabled="true"/);
  const limited = outcome(
    turn({ status: "failed", stopReason: "length", error: "x" }),
  );
  assert.match(limited, /Claudex reached its max length for this message\./);
  assert.match(limited, />Continue</);
  assert.doesNotMatch(
    outcome(turn({ status: "failed", stopReason: "length" }), false),
    />Continue</,
  );
  // The original keeps the cut-off text after Stop and says nothing.
  assert.equal(
    outcome(
      turn({
        status: "interrupted",
        items: [{ id: "m", type: "agentMessage", text: "Part of an answer" }],
      }),
    ),
    "",
  );
  // A stop before anything was written would leave the reply blank: the
  // original says so, with Edit prompt and Try again.
  const stopped = outcome(turn({ status: "interrupted" }));
  assert.match(stopped, /Claudex’s response was interrupted\./);
  assert.match(stopped, />Edit prompt</);
  assert.match(stopped, />Try again</);
  // Only Chat has the editor Edit prompt opens.
  assert.match(
    outcome(turn({ status: "interrupted" }), true, { mode: "code" }),
    /Session was interrupted/,
  );
  assert.match(
    outcome(turn({ status: "interrupted", stopReason: "restart" })),
    /Claudex closed before this response finished/,
  );
  assert.match(
    outcome(turn({ status: "inProgress", reconnecting: "3/5" })),
    /Request failed\. Retrying now \(attempt 3 of 5\)/,
  );
  assert.match(
    outcome(
      turn({
        status: "inProgress",
        reconnecting: "2/5",
        reconnectCause: "rate_limit",
      }),
    ),
    /Rate limit reached\. Retrying now \(attempt 2 of 5\)/,
  );
  assert.equal(outcome(turn({ status: "inProgress" })), "");
  assert.equal(outcome(turn({})), "");
});

test("the jump button shows only once the end is well out of view", () => {
  assert(
    !showsJumpToLatest({
      scrollHeight: 1000,
      scrollTop: 350,
      clientHeight: 500,
    }),
  );
  assert(
    showsJumpToLatest({
      scrollHeight: 1000,
      scrollTop: 250,
      clientHeight: 500,
    }),
  );
});

test("an attachment-only message sends no invented prompt text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-input-"));
  try {
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "data");
    const input = await turnInput("", [
      { id: "a", name: "notes.txt", path: file, kind: "text", size: 4 },
    ]);
    assert.equal(input.length, 1);
    assert.match(input[0].text, /<attached_file name="notes.txt">/);
    assert.equal((await turnInput("Hi", []))[0].text, "Hi");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("engine events record reconnects, the output limit and restarts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-states-"));
  try {
    const store = new Store(root);
    const c: Conversation = {
      id: "c",
      title: "c",
      mode: "chat",
      providerId: "p",
      model: "m",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      threadId: "thread",
      turns: [turn({ id: "turn", status: "inProgress" })],
    };
    store.conversations = [c];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    ) as any;
    engine.routes.set("thread", "c");
    const send = (method: string, params: object) =>
      engine.notification({
        method,
        params: { threadId: "thread", turnId: "turn", ...params },
      });
    send("error", {
      willRetry: true,
      error: { message: "Reconnecting... 1/5" },
    });
    assert.equal(c.turns[0].reconnecting, "1/5");
    send("item/agentMessage/delta", { itemId: "m", delta: "Hi" });
    assert.equal(c.turns[0].reconnecting, undefined);
    send("turn/completed", {
      turn: {
        id: "turn",
        status: "failed",
        error: { message: `stream error: ${lengthLimitMessage}` },
      },
    });
    assert.equal(c.turns[0].status, "failed");
    assert.equal(c.turns[0].stopReason, "length");

    for (const detail of [
      { status: "failed", error: { code: "tool_use_limit" } },
      { status: "completed", incomplete_details: { reason: "max_tool_calls" } },
      { status: "completed", stopReason: "tool_use_limit" },
      { status: "completed", stop_reason: "tool_use_limit" },
    ]) {
      send("turn/completed", { turn: { id: "turn", ...detail } });
      assert.equal(c.turns[0].status, "failed");
      assert.equal(c.turns[0].stopReason, "tool_use_limit");
    }

    // A turn still running when the app closed reopens as interrupted.
    c.turns.push(turn({ id: "open", status: "inProgress" }));
    store.flush();
    const reopened = new Store(root).conversation("c").turns.at(-1)!;
    assert.equal(reopened.status, "interrupted");
    assert.equal(reopened.stopReason, "restart");
    assert.equal(reopened.error, undefined);

    // History saved by earlier versions kept a note as the error instead.
    c.turns.push(
      turn({
        id: "legacy",
        status: "interrupted",
        error:
          "\u4e0a\u6b21\u5e94\u7528\u5173\u95ed\u65f6\u4efb\u52a1\u88ab\u4e2d\u65ad\uff0c\u53ef\u4ee5\u53d1\u9001\u6d88\u606f\u7ee7\u7eed\u3002",
      }),
    );
    store.flush();
    const legacy = new Store(root).conversation("c").turns.at(-1)!;
    assert.equal(legacy.stopReason, "restart");
    assert.equal(legacy.error, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Code session that ran out of room offers a new session instead of Try again", () => {
  const full = turn({
    status: "failed",
    error:
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
  });
  const html = outcome(full, true, { mode: "code", onHandOff() {} });
  assert.match(
    html,
    /This session is full\. Start a new session to keep going\./,
  );
  assert.match(html, />Hand off to a new session</);
  assert.doesNotMatch(html, />Try again</);
  assert.doesNotMatch(html, /context window/);
  // An older reply tells it without the button; Chat has its own full-chat notice.
  assert.doesNotMatch(
    outcome(full, false, { mode: "code", onHandOff() {} }),
    /<button/,
  );
  assert.match(outcome(full, true, { mode: "chat" }), /This chat is full/);
  assert.match(outcome(full, true, { mode: "code" }), />Try again</);
  const waiting = outcome(full, true, {
    mode: "code",
    onHandOff() {},
    busy: true,
  });
  assert.match(waiting, /aria-disabled="true"/);
});
