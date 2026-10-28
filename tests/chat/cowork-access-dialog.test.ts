import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderAccessDialog } from "../../src/cowork/FolderAccessDialog";
import {
  coworkFolderPermissionMessage,
  type CoworkFolderAccess,
} from "../../shared/cowork-api";
import {
  folderAccessCopy,
  isFolderPermissionError,
  pendingFolderAccess,
  requestFolderAccess,
  resetFolderAccessForTests,
} from "../../src/cowork/useFolderAccess";

const noop = () => undefined;

function dialog(
  extra: Partial<Parameters<typeof FolderAccessDialog>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(FolderAccessDialog, {
      folder: "/Users/me/Reports",
      name: "Reports",
      platform: "darwin",
      onCancel: noop,
      onAllow: noop,
      onAlwaysAllow: noop,
      ...extra,
    }),
  );
}

test("the folder request is a nonmodal card with the session path", () => {
  const html = dialog();
  assert.match(html, /role="region"/);
  assert.doesNotMatch(html, /aria-modal|role="alertdialog"/);
  assert.match(html, /Claudex would like to <strong>Cowork<\/strong> in:/);
  assert.match(html, /title="\/Users\/me\/Reports"/);
});

test("the initial buttons are Deny and Allow, with Allow primary", () => {
  const html = dialog();
  const labels = [...html.matchAll(/<footer>(.*)<\/footer>/g)][0][1]
    .split("</button>")
    .map((part) => part.replace(/<[^>]+>/g, ""))
    .filter(Boolean);
  assert.deepEqual(labels, ["Deny", "Allow"]);
  assert.match(html, /class="cowork-access-allow"[^>]*>Allow</);
});

test("additional folders show reason, device, normalized paths and Add folders", () => {
  const html = dialog({
    addition: true,
    paths: ["C:\\Work", "/reports"],
    reason: "Read reports",
    deviceName: "Laptop",
  });
  assert.match(html, /Claudex would like to add these folders to the session:/);
  assert.match(html, /C:\/Work/);
  assert.match(html, /On Laptop/);
  assert.match(html, /Claudex’s reason/);
  assert.match(html, /Read reports/);
  assert.match(html, />Not now</);
  assert.match(html, />Add folders</);
  const failed = dialog({ error: "This folder no longer exists." });
  assert.match(failed, /role="alert">This folder no longer exists\.</);
  const busy = dialog({ busy: true });
  assert.equal((busy.match(/disabled=""/g) ?? []).length, 2);
  assert.deepEqual(folderAccessCopy({}, "linux").warning, undefined);
});

type Calls = { access: unknown[][]; grant: unknown[][] };

function fakeBridge(state: CoworkFolderAccess["state"], extra = {}) {
  const calls: Calls = { access: [], grant: [] };
  const api = {
    coworkFolderAccess: async (...args: unknown[]) => {
      calls.access.push(args);
      return {
        state,
        folder: "/real/Reports",
        name: "Reports",
        ...extra,
      } as CoworkFolderAccess;
    },
    grantCoworkFolder: async (...args: unknown[]) => {
      calls.grant.push(args);
      return {
        state: "granted",
        folder: "/real/Reports",
        name: "Reports",
      } as CoworkFolderAccess;
    },
  };
  return { api, calls };
}

test("allowed folders pass without the dialog", async () => {
  for (const state of ["default", "trusted", "granted"] as const) {
    resetFolderAccessForTests(0);
    const { api, calls } = fakeBridge(state);
    assert.equal(await requestFolderAccess("/Reports", { api }), "granted");
    assert.equal(calls.grant.length, 0);
    assert.equal(pendingFolderAccess(), undefined);
  }
});

test("a refused folder is explained and cancelled", async () => {
  resetFolderAccessForTests(1);
  const { api } = fakeBridge("refused", { reason: "Choose a folder inside." });
  const notes: string[] = [];
  assert.equal(
    await requestFolderAccess("/", { api, notify: (m) => notes.push(m) }),
    "cancelled",
  );
  assert.deepEqual(notes, ["Choose a folder inside."]);
});

test("Allow grants for this task, Always allow trusts, Cancel grants nothing", async () => {
  resetFolderAccessForTests(1);
  let { api, calls } = fakeBridge("ask");
  let asked = requestFolderAccess("/Reports", { api });
  await new Promise((r) => setImmediate(r));
  assert.equal(pendingFolderAccess()?.access.name, "Reports");
  await pendingFolderAccess()!.answer("allow");
  assert.equal(await asked, "granted");
  assert.deepEqual(calls.grant, [["/Reports", "session", {}]]);
  assert.equal(pendingFolderAccess(), undefined);

  ({ api, calls } = fakeBridge("ask"));
  asked = requestFolderAccess("/Reports", { api, conversationId: "c1" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.access, [["/Reports", "c1"]]);
  await pendingFolderAccess()!.answer("always");
  assert.equal(await asked, "granted");
  assert.deepEqual(calls.grant, [
    ["/Reports", "always", { conversationId: "c1" }],
  ]);

  ({ api, calls } = fakeBridge("ask"));
  asked = requestFolderAccess("/Reports", { api });
  await new Promise((r) => setImmediate(r));
  await pendingFolderAccess()!.answer("cancel");
  assert.equal(await asked, "cancelled");
  assert.equal(calls.grant.length, 0);
});

test("a failed grant keeps the request open; a newer request replaces it", async () => {
  resetFolderAccessForTests(1);
  const { api } = fakeBridge("ask");
  api.grantCoworkFolder = async () => {
    throw new Error("This folder no longer exists.");
  };
  const first = requestFolderAccess("/Reports", { api });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(pendingFolderAccess()!.answer("allow"), /no longer/);
  assert.ok(pendingFolderAccess());
  const second = requestFolderAccess("/Other", { api });
  assert.equal(await first, "cancelled");
  await new Promise((r) => setImmediate(r));
  assert.equal(pendingFolderAccess()?.path, "/Other");
  await pendingFolderAccess()!.answer("cancel");
  assert.equal(await second, "cancelled");
});

test("without a dialog host a request fails instead of hanging", async () => {
  resetFolderAccessForTests(0);
  const { api } = fakeBridge("ask");
  await assert.rejects(
    requestFolderAccess("/Reports", { api }),
    /can't ask for folder access/,
  );
});

test("the main process's refusal is recognised, with or without Electron's prefix", () => {
  assert.ok(isFolderPermissionError(new Error(coworkFolderPermissionMessage)));
  assert.ok(
    isFolderPermissionError(
      new Error(
        `Error invoking remote method 'send': Error: ${coworkFolderPermissionMessage}`,
      ),
    ),
  );
  assert.ok(!isFolderPermissionError(new Error("Model service unavailable.")));
});

test("a grant on its way is not cancelled by a newer request", async () => {
  resetFolderAccessForTests(1);
  const { api } = fakeBridge("ask");
  let finish!: () => void;
  api.grantCoworkFolder = () =>
    new Promise<CoworkFolderAccess>((resolve) => {
      finish = () =>
        resolve({ state: "trusted", folder: "/real/Reports", name: "R" });
    });
  const first = requestFolderAccess("/Reports", { api });
  await new Promise((r) => setImmediate(r));
  const granting = pendingFolderAccess()!.answer("always");
  const second = requestFolderAccess("/Other", { api });
  await new Promise((r) => setImmediate(r));
  assert.equal(pendingFolderAccess()?.path, "/Other");
  finish();
  await granting;
  // The folder really was trusted, so the first caller hears "granted".
  assert.equal(await first, "granted");
  assert.equal(pendingFolderAccess()?.path, "/Other");
  await pendingFolderAccess()!.answer("cancel");
  assert.equal(await second, "cancelled");
});

test("a Cowork send refused for its folder asks, then sends the same message once", async () => {
  resetFolderAccessForTests(1);
  const sent: unknown[] = [];
  const accessCalls: unknown[][] = [];
  const grants: unknown[][] = [];
  let refuse = 1;
  const desktop = {
    send: async (input: unknown) => {
      sent.push(input);
      if (refuse-- > 0) throw new Error(coworkFolderPermissionMessage);
      return { id: "c-new", mode: "cowork" };
    },
    coworkFolderAccess: async (...args: unknown[]) => {
      accessCalls.push(args);
      return { state: "ask", folder: "/real/Reports", name: "Reports" };
    },
    grantCoworkFolder: async (...args: unknown[]) => {
      grants.push(args);
      return { state: "granted", folder: "/real/Reports", name: "Reports" };
    },
  };
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = { desktop };
  try {
    const { sendDraft } = await import("../../src/app/composer-send");
    const reported: unknown[] = [];
    let text = "Tidy the reports";
    const app = {
      accountId: "folder-fixture-account",
      draftSession: "folder-fixture-draft",
      controllerScope: {},
      text,
      attachments: [],
      sending: false,
      running: false,
      active: undefined,
      activeId: undefined,
      model: "gpt-test",
      providerId: "p1",
      mode: "cowork",
      snapshot: { settings: {} },
      cwd: "/Reports",
      projectId: undefined,
      project: undefined,
      policy: { webSearch: false },
      draftWebSearch: false,
      incognitoShown: false,
      selectNext: { current: false },
      follow: { current: false },
      navigation: { replaceNext: () => undefined },
      composer: { current: undefined },
      setSending: () => undefined,
      setError: () => undefined,
      setText: (value: string) => {
        text = value;
      },
      setAttachments: () => undefined,
      upsert: () => undefined,
      setActiveId: () => undefined,
      setPage: () => undefined,
      notify: () => undefined,
      report: (e: unknown) => reported.push(e),
    };
    const done = sendDraft(app as never);
    for (let i = 0; i < 50 && !pendingFolderAccess(); i++)
      await new Promise((r) => setImmediate(r));
    assert.deepEqual(reported, [], String(reported[0]));
    assert.equal(pendingFolderAccess()?.path, "/Reports");
    assert.equal(text, "Tidy the reports");
    await pendingFolderAccess()!.answer("allow");
    await done;
    assert.deepEqual(accessCalls, [["/Reports", undefined]]);
    assert.deepEqual(grants, [["/Reports", "session", {}]]);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.equal(text, "");
    assert.deepEqual(reported, []);

    // Cancel keeps the draft and sends nothing more.
    refuse = 1;
    sent.length = 0;
    text = "Again";
    const cancelled = sendDraft({ ...app, text } as never);
    for (let i = 0; i < 50 && !pendingFolderAccess(); i++)
      await new Promise((r) => setImmediate(r));
    await pendingFolderAccess()!.answer("cancel");
    await cancelled;
    assert.equal(sent.length, 1);
    assert.equal(text, "Again");
    assert.deepEqual(reported, []);
  } finally {
    g.window = before;
  }
});
