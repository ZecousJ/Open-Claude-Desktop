import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { defaultSettings } from "../../electron/store/store";
import { PrivacyTab } from "../../src/settings/tabs/Privacy";
import { AppContext, type AppController } from "../../src/app/AppContext";
import type { TabProps } from "../../src/settings/context";
import type { ReportingStatus } from "../../shared/diagnostics-api";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { currentToasts, dismissAllToasts } from "../../src/ui/toast-store";
import { routineDom } from "../support/routine-dom";

type Bridge = Window["desktop"];
type Listener = Parameters<Bridge["onEvent"]>[0];
type Event = Parameters<Listener>[0];
const noop = () => {};
const reporting: ReportingStatus = {
  diagnostics: true,
  feedback: true,
  allowConversationExcerpt: false,
  consented: true,
};
const sharing: SharingStatus = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 100,
  maxArtifactBytes: 100,
};
const share: HostedShare = {
  id: "owned-share",
  kind: "conversation",
  sourceKey: "chat-a",
  title: "Owned synthetic chat",
  url: "https://fixture.invalid/s/owned",
  createdAt: 1,
  snapshotAt: 1,
  status: "active",
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(overrides: Partial<Bridge> = {}) {
  const listeners = new Set<Listener>();
  const errors: unknown[] = [],
    saves: unknown[] = [],
    links: string[] = [];
  const env = await routineDom(
    {
      reportingStatus: async () => reporting,
      sharingStatus: async () => sharing,
      signUpProfile: async () => null,
      exportData: async () => null,
      hostedShares: async () => [share],
      sharedArtifacts: async () => [
        { identity: "artifact-a", title: "Owned artifact" },
      ],
      openExternal: async (url) => {
        links.push(url);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ...overrides,
    },
    { jsdom: true },
  );
  const current: { current: AppController | undefined } = {
    current: undefined,
  };
  const actor = (id: string) =>
    ({
      accountId: id,
      controllerScope: {},
      currentController: current,
      listed: [],
      setSettingsOpen: noop,
      openConversation: noop,
    }) as unknown as AppController;
  let app = actor("account-a");
  current.current = app;
  const props: TabProps = {
    settings: { ...defaultSettings, helpImproveClaudex: true },
    platform: "darwin",
    engine: { state: "ready" },
    save: (patch) => {
      saves.push(patch);
    },
    goTo: noop,
    onError: (error) => {
      errors.push(error);
    },
  };
  const render = () =>
    env.render(h(AppContext.Provider, { value: app }, h(PrivacyTab, props)));
  await render();
  return {
    ...env,
    props,
    current,
    errors,
    saves,
    links,
    render,
    switchAccount: async (id = "account-b") => {
      app = actor(id);
      current.current = app;
      await render();
    },
    emit: async (event: Event) =>
      act(async () => {
        for (const listener of [...listeners]) listener(event);
      }),
  };
}
const row = (label: string) => `[data-setting="${label}"]`;
const button = (label: string) => `${row(label)} button`;
const settle = async (run: () => void) =>
  act(async () => {
    run();
  });

test("actual Privacy reuses live disclosure/data rows and only enables supported controls", async () => {
  const env = await fixture();
  try {
    for (const label of ["Uploaded files", "Your feedback"])
      assert.equal(
        env.document.querySelector<HTMLButtonElement>(button(label))!.disabled,
        true,
      );
    for (const label of [
      "Export data",
      "Shared chats",
      "Shared artifacts",
      "Memory preferences",
    ])
      assert.equal(
        env.document.querySelector<HTMLButtonElement>(button(label))!.disabled,
        false,
      );
    const disclosure = `${row("How we protect your data")} button`;
    assert.equal(
      env.document.querySelector(disclosure)!.getAttribute("aria-expanded"),
      "false",
    );
    await env.click(disclosure);
    assert.equal(
      env.document.querySelector(disclosure)!.getAttribute("aria-expanded"),
      "true",
    );
    assert.ok(env.document.querySelector(".privacy-explanation-body"));
    await env.click('[role="switch"][aria-label="Location metadata"]');
    assert.deepEqual(env.saves, [{ locationMetadata: false }]);
    await env.click(button("Shared chats"));
    assert.equal(
      env.document
        .querySelector('table[aria-label="Shared chats"] tbody')!
        .textContent!.includes(share.title),
      true,
    );
    await env.click(".privacy-subpage-back button");
    assert.equal(
      env.document.activeElement,
      env.document.querySelector(button("Shared chats")),
    );
  } finally {
    await env.clean();
  }
});

test("pending status, terms and export results cannot cross the account/controller owner", async () => {
  const oldReport = deferred<ReportingStatus | null>(),
    oldSharing = deferred<SharingStatus | null>();
  const oldTerms = deferred<Awaited<ReturnType<Bridge["signUpProfile"]>>>(),
    exported = deferred<string | null>();
  let count = 0,
    shareCount = 0,
    termCount = 0;
  const env = await fixture({
    reportingStatus: () =>
      ++count === 1 ? oldReport.promise : Promise.resolve(null),
    sharingStatus: () =>
      ++shareCount === 1 ? oldSharing.promise : Promise.resolve(null),
    signUpProfile: () =>
      ++termCount === 1 ? oldTerms.promise : Promise.resolve(null),
    exportData: () => exported.promise,
  });
  try {
    await env.click(button("Export data"));
    await env.switchAccount();
    await settle(() => {
      oldReport.resolve(reporting);
      oldSharing.resolve(sharing);
      oldTerms.resolve({
        termsUrl: "https://old-owner.invalid/terms",
      } as Awaited<ReturnType<Bridge["signUpProfile"]>>);
      exported.resolve("/old-owner/export.zip");
    });
    assert.equal(env.document.querySelector(button("Terms of Service")), null);
    assert.equal(env.document.body.textContent!.includes("/old-owner"), false);
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(button("Shared chats"))!
        .disabled,
      true,
    );
    assert.equal(
      env.document
        .querySelector('[aria-label="Help improve Claudex"]')!
        .getAttribute("aria-checked"),
      "false",
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(button("Export data"))!
        .disabled,
      false,
    );
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("service changes re-read terms with status and invalidate an old export rejection", async () => {
  const exported = deferred<string | null>();
  let service = "a",
    calls = 0;
  const env = await fixture({
    signUpProfile: async () => {
      calls++;
      return { termsUrl: `https://${service}.invalid/terms` } as Awaited<
        ReturnType<Bridge["signUpProfile"]>
      >;
    },
    exportData: () => exported.promise,
  });
  try {
    await env.click(button("Terms of Service"));
    assert.deepEqual(env.links, ["https://a.invalid/terms"]);
    await env.click(button("Export data"));
    service = "b";
    await env.emit({ type: "service-changed" });
    await env.click(button("Terms of Service"));
    assert.equal(calls, 2);
    assert.deepEqual(env.links, [
      "https://a.invalid/terms",
      "https://b.invalid/terms",
    ]);
    await settle(() => exported.reject(new Error("old owner export failed")));
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("same-owner export succeeds and current failures remain visible", async () => {
  let attempt = 0;
  const env = await fixture({
    exportData: async () => {
      if (++attempt === 1) return "/synthetic/export.zip";
      throw new Error("current export failed");
    },
  });
  try {
    await env.click(button("Export data"));
    assert.ok(
      env.document
        .querySelector(row("Export data"))!
        .textContent!.includes("Saved to /synthetic/export.zip"),
    );
    await env.click(button("Export data"));
    assert.equal((env.errors[0] as Error).message, "current export failed");
  } finally {
    await env.clean();
  }
});

test("manager reads use request order and reject previous-controller results", async () => {
  const first = deferred<HostedShare[]>(),
    second = deferred<HostedShare[]>();
  let calls = 0;
  const env = await fixture({
    hostedShares: () => (++calls === 1 ? first.promise : second.promise),
  });
  try {
    await env.click(button("Shared chats"));
    await env.emit({ type: "sharing", kind: "conversation" });
    await settle(() =>
      second.resolve([{ ...share, title: "Newest current result" }]),
    );
    await settle(() =>
      first.resolve([{ ...share, title: "Stale old result" }]),
    );
    assert.ok(env.document.body.textContent!.includes("Newest current result"));
    assert.equal(
      env.document.body.textContent!.includes("Stale old result"),
      false,
    );
    const pending = deferred<HostedShare[]>();
    env.window.desktop.hostedShares = () => pending.promise;
    await env.emit({ type: "sharing", kind: "conversation" });
    await env.switchAccount();
    await settle(() =>
      pending.resolve([{ ...share, title: "Previous owner private row" }]),
    );
    assert.equal(
      env.document.body.textContent!.includes("Previous owner private row"),
      false,
    );
  } finally {
    await env.clean();
  }
});

test("a queued unshare cancels on owner change and cannot call the replacement bridge", async () => {
  let revokes = 0;
  const env = await fixture({
    revokeShare: async () => {
      revokes++;
    },
  });
  try {
    await env.click(button("Shared chats"));
    await env.click('button[aria-label="Unshare Owned synthetic chat"]');
    assert.equal(revokes, 0);
    await env.switchAccount();
    await act(async () => dismissAllToasts());
    assert.equal(revokes, 0);
    assert.equal(
      currentToasts().some(
        (toast) => toast.message === "Unshared “Owned synthetic chat”",
      ),
      false,
    );
  } finally {
    await env.clean();
  }
});

test("same-owner Undo restores the row; leaving a manager commits only its captured API", async () => {
  let revokes = 0;
  const env = await fixture({
    revokeShare: async () => {
      revokes++;
    },
  });
  try {
    await env.click(button("Shared chats"));
    await env.click('button[aria-label="Unshare Owned synthetic chat"]');
    const undo = currentToasts().find(
      (toast) => toast.action?.label === "Undo",
    )!;
    await act(async () => {
      undo.action!.onSelect();
      dismissAllToasts();
    });
    assert.equal(revokes, 0);
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Unshare Owned synthetic chat"]',
      ),
    );
    await env.click('button[aria-label="Unshare Owned synthetic chat"]');
    await env.click(".privacy-subpage-back button");
    assert.equal(revokes, 1);
  } finally {
    await env.clean();
  }
});

test("signed-out events clear private manager data and cancel deferred artifact removals", async () => {
  let removals = 0;
  const env = await fixture({
    stopSharingArtifact: async () => {
      removals++;
      return [];
    },
  });
  try {
    await env.click(button("Shared artifacts"));
    await env.click('button[aria-label="Unpublish Owned artifact"]');
    await env.emit({
      type: "signed-out",
      reason: "session-expired",
      message: "Synthetic session ended",
    });
    await act(async () => dismissAllToasts());
    assert.equal(removals, 0);
    assert.equal(
      env.document.body.textContent!.includes("Owned artifact"),
      false,
    );
  } finally {
    await env.clean();
  }
});

test("an in-flight revoke cannot publish success or errors into a replacement owner", async () => {
  for (const failed of [false, true]) {
    const pending = deferred<void>();
    const env = await fixture({ revokeShare: () => pending.promise });
    try {
      await env.click(button("Shared chats"));
      await env.click('button[aria-label="Unshare Owned synthetic chat"]');
      await act(async () => dismissAllToasts());
      await env.switchAccount();
      await settle(() => {
        if (failed) pending.reject(new Error("previous owner failed"));
        else pending.resolve();
      });
      assert.deepEqual(env.errors, []);
      assert.equal(
        currentToasts().some(
          (toast) => toast.message === "Unshared “Owned synthetic chat”",
        ),
        false,
      );
    } finally {
      await env.clean();
    }
  }
});
