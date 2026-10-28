import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppContext } from "../../electron/app/app-context";
import { exportArchive } from "../../electron/conversations/data-export";
import { registerSettingsAccountHandlers } from "../../electron/ipc/settings-account";
import { defaultSettings } from "../../electron/store/store";
import { preferenceDefaults } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import type { ReportingStatus } from "../../shared/diagnostics-api";
import {
  InstructionsField,
  instructionsLimit,
  instructionsTooLong,
} from "../../src/settings/InstructionsField";
import {
  AccountSection,
  AccountTab,
  administratorDeletesNote,
} from "../../src/settings/tabs/Account";
import {
  PreferencesSection,
  collectsReports,
  notCollecting,
} from "../../src/settings/tabs/Privacy";
import { SharedArtifactsTable } from "../../src/settings/tabs/PrivacyShared";
import type { Conversation, Settings } from "../../shared/types";

/** The files of a .zip made by `createZip`, unpacked. */
function unzip(archive: Buffer) {
  const files = new Map<string, string>();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const name = archive.toString(
      "utf8",
      offset + 30,
      offset + 30 + nameLength,
    );
    const body = archive.subarray(start, start + size);
    files.set(
      name,
      (method === 8 ? zlib.inflateRawSync(body) : body).toString("utf8"),
    );
    offset = start + size;
  }
  return files;
}

/** A context for the Settings → Account handlers; calls on anything else fail the test. */
function accountContext(remote: boolean, calls: string[]) {
  const record =
    (name: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push(name);
      void args;
      return result;
    };
  return {
    activeAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "ada@example.com",
      name: "Ada",
    },
    remote: remote
      ? {
          backend: {
            accounts: { removeDeleted: record("remove remote profile") },
            session: {
              end: () => calls.push("end session"),
              authorized: async (fn: (token: string) => unknown) => {
                calls.push("remote request");
                return fn("token");
              },
            },
            client: {
              deleteAccount: async (token: string) => {
                assert.equal(token, "token");
                calls.push("delete remote account");
              },
              profile: async () => ({
                username: "ada",
                email: "ada@example.com",
              }),
            },
          },
        }
      : undefined,
    accounts: {
      verify: async (...args: unknown[]) => (
        record("verify")(...args),
        args[1] === "correct horse battery"
      ),
      remove: record("remove"),
      removeSignedIn: record("remove signed in"),
      rename: record("rename"),
      hasAccounts: false,
    },
    deactivate: async () => void calls.push("deactivate"),
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "claudex-account-")),
  } as unknown as AppContext;
}

function handlers(ctx: AppContext) {
  const found = new Map<string, (...args: any[]) => any>();
  registerSettingsAccountHandlers((name, fn) => found.set(name, fn), ctx);
  return found;
}

test("a remote account deletes only through its authorized session", async () => {
  const calls: string[] = [];
  const ctx = accountContext(true, calls);
  const handle = handlers(ctx);
  await handle.get("deleteAccount")!();
  assert.deepEqual(calls, [
    "remote request",
    "delete remote account",
    "end session",
    "deactivate",
    "remove remote profile",
  ]);
  const profile = await handle.get("accountProfile")!();
  assert.equal(profile.canDelete, true);
  // The managed-account row explains who can deprovision it, without a button.
  const markup = renderToStaticMarkup(
    createElement(AccountSection, {
      profile: { ...profile, canDelete: false },
      onDelete: () => {},
    }),
  );
  assert.match(markup, new RegExp(administratorDeletesNote));
  assert.match(markup, /settings-delete-managed/);
  assert.doesNotMatch(
    markup,
    /<button(?![^>]*disabled="")[^>]*>Delete account/,
  );
});

test("deleting a local account uses its active session, not a password", async () => {
  const calls: string[] = [];
  const ctx = accountContext(false, calls);
  const handle = handlers(ctx);
  assert.deepEqual(await handle.get("deleteAccount")!(), {
    hasAccounts: false,
  });
  assert.deepEqual(calls, ["deactivate", "remove signed in"]);
  const markup = renderToStaticMarkup(
    createElement(AccountSection, {
      profile: await handle.get("accountProfile")!(),
      onSignOut: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(markup, /<button[^>]*>Delete account<\/button>/);
  assert.match(markup, /Log out of this device/);
  // "Delete your account" with a primary button, not a red one.
  assert.match(markup, />Delete your account</);
  assert.match(markup, /<button[^>]*primary[^>]*>Delete account<\/button>/);
  assert.doesNotMatch(markup, /<button[^>]*danger[^>]*>Delete account/);
});

test("deletion refuses a missing account and keeps a remote session on failure", async () => {
  const calls: string[] = [];
  const local = accountContext(false, calls);
  Object.assign(local, { activeAccount: undefined });
  await assert.rejects(
    handlers(local).get("deleteAccount")!(),
    /Not signed in/,
  );
  assert.deepEqual(calls, []);
  const remote = accountContext(true, calls);
  remote.remote!.backend.client.deleteAccount = async () => {
    throw Error("offline");
  };
  await assert.rejects(handlers(remote).get("deleteAccount")!(), /offline/);
  assert.deepEqual(calls, ["remote request"]);
});

test("Account has no Organization ID row, and revoke-all has no extra description", () => {
  const remote = renderToStaticMarkup(
    createElement(AccountSection, {
      profile: {
        kind: "remote",
        fullName: "Ada",
        email: "z@example.com",
        canDelete: false,
      },
      onSignOutEverywhere: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(remote, /Log out of all devices/);
  assert.doesNotMatch(remote, /API keys|Signs out every device/);
  assert.match(remote, /settings-button[^\"]*"[^>]*>Log out/);
  const page = renderToStaticMarkup(
    createElement(AccountTab, {
      settings: defaultSettings,
      save: () => {},
      platform: "darwin",
      engine: { state: "ready" },
      onError: () => {},
      goTo: () => {},
    } as never),
  );
  for (const markup of [remote, page])
    assert.doesNotMatch(markup, /Organi[sz]ation/i);
});

test("the exported .zip holds no keys, MCP secrets or share tokens", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-export-"));
  try {
    fs.writeFileSync(
      path.join(root, "artifact-shares.json"),
      JSON.stringify({
        version: 1,
        entries: [{ identity: "a", token: "e".repeat(64), title: "Chart" }],
      }),
    );
    fs.writeFileSync(path.join(root, "secrets.enc"), "vault-secret");
    const settings: Settings = {
      ...defaultSettings,
      providers: [
        {
          id: "p",
          name: "Service",
          baseUrl: "https://gateway.example.com/v1",
          model: "m",
          apiKey: "sk-provider-secret",
        } as never,
      ],
      mcpServers: {
        github: {
          command: "npx",
          args: ["github-mcp", "--token", "ghp-arg-secret"],
          env: { GITHUB_TOKEN: "ghp-env-secret" },
        },
        remote: {
          url: "https://u:pw-secret@mcp.example.com/sse?key=q-secret",
          headers: { Authorization: "Bearer h-secret" },
        },
      },
    };
    const files = unzip(
      exportArchive({ root, conversations: [], projects: [], settings }),
    );
    assert.ok(files.has("settings.json"));
    assert.ok(files.has("README.txt"));
    assert.equal(files.has("secrets.enc"), false);
    const text = [...files.values()].join("\n");
    for (const secret of [
      "sk-provider-secret",
      "gateway.example.com",
      "ghp-arg-secret",
      "ghp-env-secret",
      "pw-secret",
      "q-secret",
      "h-secret",
      "vault-secret",
      "e".repeat(64),
    ])
      assert.equal(text.includes(secret), false, secret);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local export includes chats, Cowork tasks and Code sessions, excluding incognito", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-export-modes-"));
  try {
    const conversations: Conversation[] = (
      ["chat", "cowork", "code"] as const
    ).map((mode) => ({
      id: mode,
      title: `${mode} history`,
      mode,
      providerId: "provider",
      model: "model",
      pinned: false,
      archived: mode === "code",
      createdAt: 1,
      updatedAt: 2,
      turns: [],
    }));
    const files = unzip(
      exportArchive({
        root,
        conversations: [
          ...conversations,
          {
            ...conversations[0],
            id: "private",
            title: "private",
            incognito: true,
          },
        ],
        projects: [],
        settings: defaultSettings,
      }),
    );
    assert.deepEqual(
      JSON.parse(files.get("conversations.json")!).map(
        (conversation: Conversation) => conversation.mode,
      ),
      ["chat", "cowork", "code"],
    );
    for (const conversation of conversations)
      assert.ok(files.has(`conversations/${conversation.title}.md`));
    assert.equal(files.has("conversations/private.md"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Help improve Claudex shows only while the service collects, and starts off", () => {
  const status = (patch: Partial<ReportingStatus>): ReportingStatus => ({
    diagnostics: false,
    feedback: false,
    allowConversationExcerpt: false,
    consented: false,
    ...patch,
  });
  assert.equal(collectsReports(null), false);
  assert.equal(collectsReports(undefined), false);
  assert.equal(collectsReports(status({})), false);
  assert.equal(collectsReports(status({ diagnostics: true })), true);
  assert.equal(collectsReports(status({ feedback: true })), true);
  assert.equal(preferenceDefaults.helpImproveClaudex, false);
  const render = (value: ReportingStatus | null, settings = defaultSettings) =>
    renderToStaticMarkup(
      createElement(PreferencesSection, {
        status: value,
        settings,
        save: () => {},
      }),
    );
  // Without collection the original's row stays, off and disabled with the
  // reason (UI first); nothing can be consented to.
  for (const off of [render(null), render(status({}))]) {
    assert.match(
      off,
      /aria-label="Help improve Claudex" aria-checked="false"[^>]*disabled=""/,
    );
    assert.match(off, new RegExp(notCollecting));
  }
  const shown = render(status({ feedback: true }));
  assert.doesNotMatch(shown, new RegExp(notCollecting));
  assert.match(shown, /Help improve Claudex/);
  assert.match(shown, /role="switch"[^>]*aria-checked="false"/);
  assert.match(shown, /never include your prompts/);
  assert.match(
    render(status({ diagnostics: true }), {
      ...defaultSettings,
      helpImproveClaudex: true,
    }),
    /aria-checked="true"/,
  );
  // The main process accepts the consent only as a boolean.
  assert.equal(
    preferenceFields.helpImproveClaudex.safeParse(true).success,
    true,
  );
  assert.equal(
    preferenceFields.helpImproveClaudex.safeParse("yes").success,
    false,
  );
});

test("shared artifacts list what can be stopped, or say there is nothing", () => {
  const props = { failed: false, onOpen: () => {}, onUnpublish: () => {} };
  assert.match(
    renderToStaticMarkup(
      createElement(SharedArtifactsTable, { ...props, items: undefined }),
    ),
    /aria-busy="true"/,
  );
  assert.match(
    renderToStaticMarkup(
      createElement(SharedArtifactsTable, { ...props, items: [] }),
    ),
    /No shared content found/,
  );
  const list = renderToStaticMarkup(
    createElement(SharedArtifactsTable, {
      ...props,
      items: [{ identity: "a", title: "Chart" }],
    }),
  );
  assert.match(list, /Chart/);
  assert.match(list, /Unpublish Chart/);
});

test("Instructions starts quiet and warns past the limit", () => {
  const html = renderToStaticMarkup(
    createElement(InstructionsField, {
      label: "Instructions for Claudex",
      placeholders: ["e.g. one", "e.g. two"],
      value: "Be brief.",
      onSave: () => {},
    }),
  );
  // Nothing is changed yet: no Save changes, no Discard, no warning.
  assert.doesNotMatch(html, /Save changes|Discard|too long/);
  assert.match(html, /placeholder="e\.g\. one"/);
  assert.match(html, />Be brief\.<\/textarea>/);
  assert.equal(instructionsTooLong("x".repeat(instructionsLimit)), false);
  assert.equal(instructionsTooLong(`${"x".repeat(instructionsLimit)}y`), true);
  // Spaces around the text do not count.
  assert.equal(
    instructionsTooLong(` ${"x".repeat(instructionsLimit)} `),
    false,
  );
});
