import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import type {
  ReportingStatus,
  ReplyFeedbackOutcome,
  CodeFeedbackReport,
} from "../../shared/diagnostics-api";
import { CodeFeedbackFooter } from "../../src/sidebar/CodeFeedbackFooter";
import { CodeFeedbackDialog } from "../../src/code-feedback/CodeFeedbackDialog";
import { routineDom } from "../support/routine-dom";

const conversation = {
  id: "synthetic-code",
  mode: "code",
  turns: [],
} as unknown as Conversation;
const available: ReportingStatus = {
  diagnostics: true,
  feedback: true,
  consented: true,
  allowConversationExcerpt: true,
  codeSessionFeedback: true,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("Code home has the real Ant feedback glyph and a disabled session-aware action", () => {
  const html = renderToStaticMarkup(
    createElement(CodeFeedbackFooter, { accountId: "a" }),
  );
  assert.match(html, /aria-label="Send feedback"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /data-icon="Ant"/);
  assert.match(html, /Open a session to send feedback/);
});

test("Code feedback availability rejects late account replies, legacy runners and disabled consent", async () => {
  const first = deferred<ReportingStatus | null>(),
    second = deferred<ReportingStatus | null>();
  const pending = [first, second];
  const dom = await routineDom({
    reportingStatus: () => pending.shift()!.promise,
    submitCodeFeedback: async () => ({ sent: true }),
  });
  const render = (accountId: string, consent = true) =>
    dom.render(
      createElement(CodeFeedbackFooter, { conversation, accountId, consent }),
    );
  const button = () =>
    dom.document.querySelector<HTMLButtonElement>(
      '[aria-label="Send feedback"]',
    )!;
  try {
    await render("a");
    await render("b");
    await act(async () => {
      first.resolve(available);
    });
    assert.equal(button().disabled, true);
    await act(async () => {
      second.resolve(available);
    });
    assert.equal(button().disabled, false);
    dom.window.desktop.reportingStatus = async () => ({
      ...available,
      codeSessionFeedback: undefined,
    });
    await render("legacy");
    assert.equal(button().disabled, true);
    dom.window.desktop.reportingStatus = async () => available;
    await render("b", false);
    assert.equal(button().disabled, true);
  } finally {
    await dom.clean();
  }
});

test("Code feedback dialog preserves dirty input until explicit discard", async () => {
  let closed = 0;
  const dom = await routineDom();
  const button = (name: string) =>
    [...dom.document.querySelectorAll("button")].find(
      (e) => e.textContent?.trim() === name,
    )!;
  try {
    await dom.render(
      createElement(CodeFeedbackDialog, {
        conversationId: conversation.id,
        allowConversationExcerpt: false,
        onClose: () => {
          closed++;
        },
      }),
    );
    assert.equal(
      dom.document
        .querySelector('[role="alertdialog"]')
        ?.getAttribute("aria-label"),
      "Send feedback",
    );
    assert.equal(
      dom.document.querySelector("textarea")?.getAttribute("maxLength") ??
        dom.document.querySelector("textarea")?.getAttribute("maxlength"),
      "4000",
    );
    assert.equal((button("Send") as HTMLButtonElement).disabled, true);
    await dom.change("textarea", "Synthetic UI issue");
    await dom.event(button("Cancel"), "click");
    assert.equal(closed, 0);
    assert.equal(
      dom.document.querySelectorAll('[role="alertdialog"]').length,
      2,
    );
    await dom.event(button("Keep editing"), "click");
    assert.equal(
      dom.document.querySelector("textarea")?.value,
      "Synthetic UI issue",
    );
    await dom.event(button("Cancel"), "click");
    await dom.event(button("Discard"), "click");
    assert.equal(closed, 1);
  } finally {
    await dom.clean();
  }
});

test("an open Code report keeps its captured session and disappears on account switch", async () => {
  const reports: CodeFeedbackReport[] = [];
  const dom = await routineDom({
    reportingStatus: async () => available,
    submitCodeFeedback: async (report) => {
      reports.push(report);
      return { sent: true };
    },
  });
  const render = (id: string, accountId = "a") =>
    dom.render(
      createElement(CodeFeedbackFooter, {
        conversation: { ...conversation, id },
        accountId,
        consent: true,
      }),
    );
  try {
    await render("first");
    await dom.event(
      dom.document.querySelector('[aria-label="Send feedback"]')!,
      "click",
    );
    await act(async () => {
      await new Promise<void>((done) => setImmediate(done));
    });
    assert.ok(dom.document.querySelector("textarea"));
    await dom.change("textarea", "Synthetic captured-session feedback");
    await render("second");
    assert.equal(
      dom.document.querySelector("textarea")?.value,
      "Synthetic captured-session feedback",
    );
    const send = [...dom.document.querySelectorAll("button")].find(
      (e) => e.textContent === "Send",
    )!;
    await dom.event(send, "click");
    assert.equal(reports[0]?.conversationId, "first");
    await dom.event(
      dom.document.querySelector('[aria-label="Send feedback"]')!,
      "click",
    );
    await act(async () => {
      await new Promise<void>((done) => setImmediate(done));
    });
    await render("third", "b");
    assert.equal(dom.document.querySelector("textarea"), null);
  } finally {
    await dom.clean();
  }
});

test("Code feedback retries failures without clearing input and submits only once while pending", async () => {
  const reports: CodeFeedbackReport[] = [];
  let fail = true,
    closed = 0;
  const result = deferred<ReplyFeedbackOutcome>();
  const dom = await routineDom({
    submitCodeFeedback: async (report) => {
      reports.push(report);
      if (fail) throw Error("Synthetic collector failure");
      return result.promise;
    },
  });
  const send = () =>
    [...dom.document.querySelectorAll("button")].find(
      (e) => e.textContent?.trim() === "Send",
    )!;
  try {
    await dom.render(
      createElement(CodeFeedbackDialog, {
        conversationId: conversation.id,
        allowConversationExcerpt: true,
        onClose: () => {
          closed++;
        },
      }),
    );
    assert.equal(
      dom.document.querySelector<HTMLInputElement>("input[type=checkbox]")
        ?.checked ?? false,
      false,
    );
    await dom.change("textarea", "Synthetic UI issue");
    await dom.event(send(), "click");
    assert.match(
      dom.document.querySelector("[role=alert]")?.textContent ?? "",
      /Try again/,
    );
    assert.equal(
      dom.document.querySelector("textarea")?.value,
      "Synthetic UI issue",
    );
    fail = false;
    await dom.event(send(), "click");
    await dom.event(send(), "click");
    assert.equal(reports.length, 2);
    const { reportId, ...submitted } = reports[1];
    assert.match(reportId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(reportId, reports[0].reportId);
    assert.deepEqual(submitted, {
      conversationId: conversation.id,
      comment: "Synthetic UI issue",
      includeConversation: false,
    });
    assert.equal((send() as HTMLButtonElement).disabled, true);
    await act(async () => {
      result.resolve({ sent: true });
    });
    assert.equal(closed, 1);
  } finally {
    await dom.clean();
  }
});
