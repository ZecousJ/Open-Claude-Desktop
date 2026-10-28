import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { PrivacyTab } from "../../src/settings/tabs/Privacy";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { defaultSettings } from "../../electron/store/store";
import { routineDom } from "../support/routine-dom";
import type { PrivacyDataAPI } from "../../shared/privacy-data-api";
const first = {
  id: "eb526839-061b-44e0-9fe2-621d8d80f116",
  createdAt: "2026-10-19T12:00:00Z",
  rating: "down" as const,
  categories: ["wrong"],
  comment: "Synthetic reason",
  hasExcerpt: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(api: Partial<PrivacyDataAPI> = {}) {
  const errors: unknown[] = [],
    listeners = new Set<Parameters<Window["desktop"]["onEvent"]>[0]>();
  const env = await routineDom(
    {
      reportingStatus: async () => ({
        diagnostics: false,
        feedback: false,
        consented: false,
        allowConversationExcerpt: false,
      }),
      sharingStatus: async () => null,
      signUpProfile: async () => null,
      onEvent: (listener: Parameters<Window["desktop"]["onEvent"]>[0]) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      privacyDataStatus: async () => ({
        feedback: { supported: true },
        uploads: { supported: true },
      }),
      feedbackHistory: async () => ({ items: [first] }),
      withdrawFeedback: async () => ({ withdrawn: true }),
      uploadedFiles: async () => ({
        items: [],
        complete: false,
        scope: "managed-attachments",
        skipped: 0,
        truncated: false,
      }),
      ...api,
    } as never,
    { jsdom: true },
  );
  const current: { current?: AppController } = {};
  const actor = (id: string) =>
    ({
      accountId: id,
      controllerScope: {},
      currentController: current,
      listed: [],
      setSettingsOpen() {},
      openConversation() {},
    }) as unknown as AppController;
  let app = actor("account-a");
  current.current = app;
  const render = () =>
    env.render(
      h(
        AppContext.Provider,
        { value: app },
        h(PrivacyTab, {
          settings: defaultSettings,
          platform: "darwin",
          engine: { state: "ready" },
          save() {},
          goTo() {},
          onError: (error) => errors.push(error),
        }),
      ),
    );
  await render();
  const button = (text: string, scope: ParentNode = env.document) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent?.trim() === text ||
        item.getAttribute("aria-label") === text,
    )!;
  const open = async (label: "Your feedback" | "Uploaded files") => {
    const row = [...env.document.querySelectorAll(".settings-row")].find(
      (row) => row.textContent?.includes(label),
    )!;
    const manage = row.querySelector("button")!;
    assert.equal(manage.disabled, false);
    await env.event(manage, "click");
    await act(async () => {
      if (label === "Your feedback")
        await import("../../src/settings/privacy-data/FeedbackManager");
      else await import("../../src/settings/privacy-data/UploadedFilesManager");
    });
  };
  return {
    ...env,
    button,
    open,
    errors,
    listeners,
    async switchAccount() {
      app = actor("account-b");
      current.current = app;
      await render();
    },
  };
}

test("actual Privacy management checks support, errors and retries without a fake empty history", async () => {
  const pending =
    deferred<Awaited<ReturnType<PrivacyDataAPI["privacyDataStatus"]>>>();
  let reads = 0;
  const f = await fixture({
    privacyDataStatus: () => {
      reads++;
      return reads === 1
        ? pending.promise
        : Promise.resolve({
            feedback: { supported: true },
            uploads: { supported: false, reason: "unsupported-host" },
          });
    },
  });
  try {
    assert.match(f.document.body.textContent!, /Checking privacy data support/);
    const feedbackRow = [...f.document.querySelectorAll(".settings-row")].find(
      (row) => row.textContent?.includes("Your feedback"),
    )!;
    assert.equal(feedbackRow.querySelector("button")!.disabled, true);
    await act(async () => pending.reject(Error("fixture service failed")));
    assert.match(
      f.document.body.textContent!,
      /Couldn’t check privacy data support/,
    );
    assert.doesNotMatch(f.document.body.textContent!, /No feedback found/);
    await f.event(f.button("Retry"), "click");
    assert.equal(reads, 2);
    await f.open("Your feedback");
    assert.match(f.document.body.textContent!, /wrong · Synthetic reason/);
    assert.match(f.document.body.textContent!, /October 19, 2026/);
    assert.ok(
      f.document.querySelector('[role="img"][aria-label="Thumbs down"]'),
    );
  } finally {
    await f.clean();
  }
});

test("feedback loading placeholders, actual continuation and Back focus", async () => {
  const pending = deferred<{ items: (typeof first)[]; nextCursor?: string }>();
  const calls: unknown[] = [];
  const f = await fixture({
    feedbackHistory: (input) => {
      calls.push(input);
      if (calls.length === 1) return pending.promise;
      return Promise.resolve({
        items: [
          {
            ...first,
            id: "eb526839-061b-44e0-9fe2-621d8d80f117",
            comment: "Second page",
          },
        ],
      });
    },
  });
  try {
    await f.open("Your feedback");
    assert.equal(
      f.document
        .querySelector(".privacy-feedback-table")
        ?.getAttribute("aria-busy"),
      "true",
    );
    assert.doesNotMatch(f.document.body.textContent!, /No feedback found/);
    await act(async () =>
      pending.resolve({ items: [first], nextCursor: "opaque-next" }),
    );
    await f.event(f.button("Show more"), "click");
    assert.deepEqual(calls[1], { cursor: "opaque-next" });
    assert.match(f.document.body.textContent!, /Second page/);
    await f.event(f.button("Back"), "click");
    const row = [...f.document.querySelectorAll(".settings-row")].find((row) =>
      row.textContent?.includes("Your feedback"),
    )!;
    assert.equal(f.document.activeElement, row.querySelector("button"));
  } finally {
    await f.clean();
  }
});

test("withdraw confirmation, failure, retry and actual acknowledgement preserve the row until success", async () => {
  const pending = deferred<{ withdrawn: true }>();
  let calls = 0;
  const ids: string[] = [];
  const f = await fixture({
    withdrawFeedback: (id) => {
      calls++;
      ids.push(id);
      return calls === 1
        ? Promise.reject(Error("fixture withdrawal failed"))
        : pending.promise;
    },
  });
  try {
    await f.open("Your feedback");
    await f.event(f.button("Withdraw feedback"), "click");
    let dialog = f.document.querySelector('[role="alertdialog"]')!;
    assert.match(dialog.textContent!, /does not delete your chat/);
    await f.event(f.button("Cancel", dialog), "click");
    assert.equal(calls, 0);
    assert.match(f.document.body.textContent!, /Synthetic reason/);
    await f.event(f.button("Withdraw feedback"), "click");
    dialog = f.document.querySelector('[role="alertdialog"]')!;
    await f.event(f.button("Withdraw", dialog), "click");
    assert.match(dialog.textContent!, /fixture withdrawal failed/);
    assert.match(f.document.body.textContent!, /Synthetic reason/);
    await f.event(f.button("Withdraw", dialog), "click");
    assert.equal(f.button("Withdrawing…", dialog).disabled, true);
    assert.match(f.document.body.textContent!, /Synthetic reason/);
    await act(async () => pending.resolve({ withdrawn: true }));
    assert.equal(f.document.querySelector('[role="alertdialog"]'), null);
    assert.doesNotMatch(f.document.body.textContent!, /Synthetic reason/);
    assert.match(f.document.body.textContent!, /No feedback found/);
    assert.deepEqual(ids, [first.id, first.id]);
  } finally {
    await f.clean();
  }
});

test("account retirement clears private rows and suppresses a late withdrawal failure", async () => {
  const pending = deferred<{ withdrawn: true }>();
  const f = await fixture({ withdrawFeedback: () => pending.promise });
  try {
    await f.open("Your feedback");
    await f.event(f.button("Withdraw feedback"), "click");
    const dialog = f.document.querySelector('[role="alertdialog"]')!;
    await f.event(f.button("Withdraw", dialog), "click");
    await f.switchAccount();
    assert.doesNotMatch(f.document.body.textContent!, /Synthetic reason/);
    await act(async () => pending.reject(Error("retired private failure")));
    assert.equal(f.errors.length, 0);
    assert.doesNotMatch(
      f.document.body.textContent!,
      /retired private failure/,
    );
  } finally {
    await f.clean();
  }
});

test("uploads list name, size, date, surface and chats, and delete is undoable then real", async () => {
  const deleted: string[] = [];
  const f = await fixture({
    uploadedFiles: async () => ({
      items: [
        {
          id: "fixture/owned.txt",
          name: "owned.txt",
          bytes: 21_606,
          uploadedAt: null,
          surface: "code",
          locations: [{ conversationId: "c1", title: "A chat" }],
          storage: "managed-attachment",
        },
      ],
      complete: false,
      scope: "managed-attachments",
      skipped: 0,
      truncated: false,
    }),
    deleteUploadedFile: async (id) => {
      deleted.push(id);
      return { deleted: true };
    },
  });
  try {
    await f.open("Uploaded files");
    const text = () => f.document.body.textContent!;
    assert.match(text(), /Deleting a file removes it from storage/);
    assert.match(text(), /owned\.txt/);
    assert.match(text(), /21\.1 KB/);
    assert.match(text(), /1 chat/);
    assert.equal(
      f.document.querySelector(".privacy-badge")?.textContent,
      "Code",
    );
    assert.equal(f.document.querySelector("td.uploaded")?.textContent, "—");
    await f.event(f.button("Show chats for owned.txt"), "click");
    assert.match(text(), /Open chat 1/);
    await f.event(f.button("Delete owned.txt"), "click");
    assert.doesNotMatch(text(), /owned\.txt21/);
    assert.deepEqual(deleted, []);
    const { dismissAllToasts } = await import("../../src/ui/toast-store");
    await act(async () => {
      dismissAllToasts();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(deleted, ["fixture/owned.txt"]);
  } finally {
    await f.clean();
  }
});

test("unsupported service and local accounts stay explicit while a supported empty history is distinct", async () => {
  const f = await fixture({
    privacyDataStatus: async () => ({
      feedback: { supported: false, reason: "local-account" },
      uploads: { supported: false, reason: "unsupported-host" },
    }),
  });
  try {
    assert.match(
      f.document.body.textContent!,
      /Local accounts have no service feedback history/,
    );
    for (const label of ["Your feedback", "Uploaded files"]) {
      const row = [...f.document.querySelectorAll(".settings-row")].find(
        (row) => row.textContent?.includes(label),
      )!;
      assert.equal(row.querySelector("button")!.disabled, true);
    }
    const shared = [...f.document.querySelectorAll(".settings-row")].find(
      (row) => row.textContent?.includes("Shared artifacts"),
    )!;
    assert.equal(shared.querySelector("button")!.disabled, false);
  } finally {
    await f.clean();
  }
  const empty = await fixture({ feedbackHistory: async () => ({ items: [] }) });
  try {
    await empty.open("Your feedback");
    assert.match(empty.document.body.textContent!, /No feedback found/);
    assert.equal(empty.document.querySelector('[role="alert"]'), null);
  } finally {
    await empty.clean();
  }
});

test("late history reads cannot repopulate private content after a service change", async () => {
  const pending = deferred<{ items: (typeof first)[] }>();
  const f = await fixture({ feedbackHistory: () => pending.promise });
  try {
    await f.open("Your feedback");
    assert.equal(
      f.document
        .querySelector(".privacy-feedback-table")
        ?.getAttribute("aria-busy"),
      "true",
    );
    await act(async () => {
      for (const listener of f.listeners) listener({ type: "service-changed" });
    });
    await act(async () => pending.resolve({ items: [first] }));
    assert.doesNotMatch(f.document.body.textContent!, /Synthetic reason/);
    assert.equal(f.errors.length, 0);
  } finally {
    await f.clean();
  }
});
