import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Accounts, importLegacyProfile } from "../../electron/account/accounts";
import {
  exportEntries,
  exportedMcpServers,
} from "../../electron/conversations/data-export";
import { billingFrom } from "../../electron/account/billing";
import { mergeSavedSettings } from "../../electron/store/settings-merge";
import { SettingsWriteQueue } from "../../src/app/SettingsWriteQueue";
import { defaultSettings } from "../../electron/store/store";
import type { Settings } from "../../shared/types";

test("a save from the window keeps what the main process changed since", () => {
  const base: Settings = {
    ...defaultSettings,
    theme: "dark",
    mcpServers: { docs: { command: "docs-mcp" } },
    disabledSkills: [],
  };
  // Meanwhile: the MCP configuration file and a skill switch changed.
  const stored: Settings = {
    ...base,
    mcpServers: { docs: { command: "docs-mcp" }, git: { command: "git-mcp" } },
    disabledSkills: ["/skills/a/SKILL.md"],
  };
  // The window only changed the theme, from its older copy.
  const incoming: Settings = { ...base, theme: "light" };
  const saved = mergeSavedSettings(stored, incoming, base, ["disabledSkills"]);
  assert.equal(saved.theme, "light");
  assert.deepEqual(saved.mcpServers, stored.mcpServers);
  assert.deepEqual(saved.disabledSkills, ["/skills/a/SKILL.md"]);
  // A field the window did change wins.
  const edited = mergeSavedSettings(stored, { ...base, mcpServers: {} }, base, [
    "disabledSkills",
  ]);
  assert.deepEqual(edited.mcpServers, {});
  // Owned fields keep the stored value even without a base or when sent changed.
  const owned = mergeSavedSettings(
    stored,
    { ...incoming, disabledSkills: [] },
    undefined,
    ["disabledSkills"],
  );
  assert.deepEqual(owned.disabledSkills, ["/skills/a/SKILL.md"]);
  assert.equal(owned.theme, "light");
  // A preference the main process set that the window never saw stays.
  const { workType: _none, ...withoutWork } = base;
  const kept = mergeSavedSettings(
    { ...stored, workType: "Design" },
    withoutWork as Settings,
    withoutWork as Settings,
    [],
  );
  assert.equal(kept.workType, "Design");
});

test("once a save settles, the next edit starts from the published settings", async () => {
  let visible = { theme: "dark", mcp: "old" };
  const queue = new SettingsWriteQueue(
    () => visible,
    (value) => {
      visible = value;
    },
    async (value) => value,
    async () => visible,
  );
  await queue.update({ theme: "light" });
  // The main process pushed newer settings (a "settings" event).
  visible = { ...visible, mcp: "new" };
  await queue.update({ theme: "dark" });
  assert.deepEqual(visible, { theme: "dark", mcp: "new" });
});

test("deleting the first local account never moves its old data into the next one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-delete-"));
  try {
    // Data of the single-user version, in the app folder.
    fs.writeFileSync(path.join(root, "conversations.json"), "[]");
    fs.writeFileSync(path.join(root, "settings.json"), "{}");
    fs.writeFileSync(path.join(root, "secrets.enc"), "");
    fs.mkdirSync(path.join(root, "codex-home"));
    const accounts = new Accounts(root);
    const alice = await accounts.register(
      "alice@example.com",
      "correct horse battery",
      "Alice",
    );
    const bob = await accounts.register(
      "bob@example.com",
      "another long password",
      "Bob",
    );
    assert.equal(accounts.ownsLegacyData(alice.account.id), true);
    assert.equal(accounts.ownsLegacyData(bob.account.id), false);
    importLegacyProfile(root, accounts.profileRoot(alice.account.id));
    await assert.rejects(
      accounts.remove(alice.account.id, "wrong password here"),
      /incorrect/,
    );
    await accounts.remove(alice.account.id, "correct horse battery");
    // Bob is now the only (and first) account, but not the data's owner.
    const reopened = new Accounts(root);
    assert.equal(reopened.ownsLegacyData(bob.account.id), false);
    assert.equal(
      fs.existsSync(path.join(root, "profiles", alice.account.id)),
      false,
    );
    // Deleted with the account: its conversations, settings and agent home.
    assert.equal(fs.existsSync(path.join(root, "conversations.json")), false);
    assert.equal(fs.existsSync(path.join(root, "settings.json")), false);
    assert.equal(fs.existsSync(path.join(root, "codex-home")), false);
    // The computer's model keys are not the account's.
    assert.equal(fs.existsSync(path.join(root, "secrets.enc")), true);
    const carol = await reopened.register(
      "carol@example.com",
      "a third long password",
      "Carol",
    );
    assert.equal(reopened.ownsLegacyData(carol.account.id), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a registry from before the owner marker treats its first account as the owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-delete-"));
  try {
    const accounts = new Accounts(root);
    const alice = await accounts.register(
      "alice@example.com",
      "correct horse battery",
      "Alice",
    );
    const file = path.join(root, "accounts.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    delete data.legacyOwner;
    fs.writeFileSync(file, JSON.stringify(data));
    assert.equal(new Accounts(root).ownsLegacyData(alice.account.id), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the data export leaves out MCP secrets and share tokens", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-export-"));
  try {
    fs.writeFileSync(
      path.join(root, "artifact-shares.json"),
      JSON.stringify({
        version: 1,
        entries: [{ identity: "a", token: "f".repeat(64), title: "Chart" }],
      }),
    );
    const entries = exportEntries({
      root,
      conversations: [],
      projects: [],
      settings: {
        ...defaultSettings,
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "github-mcp", "--api-key", "sk-live", "--token=abc"],
            env: { GITHUB_TOKEN: "ghp_secret" },
            enabled: true,
          },
          remote: {
            url: "https://user:pass@mcp.example.com/sse?key=secret#x",
            headers: { Authorization: "Bearer secret" },
            bearer_token: "secret",
          },
          // mcp-remote passes its header as an argument; database servers
          // take a connection URL with the password in it.
          proxy: {
            command: "npx",
            args: [
              "mcp-remote",
              "https://mcp.example.com/sse?api_key=q-secret",
              "--header",
              "Authorization: Bearer h-secret",
              "-H",
              "X-Api-Key: k-secret",
              "--header=Cookie: session=c-secret",
            ],
          },
          postgres: {
            command: "npx",
            args: [
              "@modelcontextprotocol/server-postgres",
              "postgresql://admin:db-secret@localhost:5432/app?sslmode=require",
            ],
          },
        },
      },
    });
    const text = entries.map((entry) => entry.data.toString("utf8")).join("\n");
    for (const secret of [
      "ghp_secret",
      "sk-live",
      "abc",
      "Bearer",
      "pass@",
      "key=secret",
      "q-secret",
      "h-secret",
      "k-secret",
      "c-secret",
      "db-secret",
      "f".repeat(64),
    ])
      assert.equal(text.includes(secret), false, secret);
    const settings = JSON.parse(
      entries
        .find((entry) => entry.name === "settings.json")!
        .data.toString("utf8"),
    );
    assert.deepEqual(settings.mcpServers, {
      github: {
        command: "npx",
        args: [
          "-y",
          "github-mcp",
          "--api-key",
          "<redacted>",
          "--token=<redacted>",
        ],
        enabled: true,
      },
      remote: { url: "https://mcp.example.com/sse" },
      proxy: {
        command: "npx",
        args: [
          "mcp-remote",
          "https://mcp.example.com/sse",
          "--header",
          "Authorization: <redacted>",
          "-H",
          "X-Api-Key: <redacted>",
          "--header=Cookie: <redacted>",
        ],
      },
      postgres: {
        command: "npx",
        args: [
          "@modelcontextprotocol/server-postgres",
          "postgresql://localhost:5432/app",
        ],
      },
    });
    assert.equal("providers" in settings, false);
    assert.ok(entries.some((entry) => entry.name === "artifact-shares.json"));
    assert.deepEqual(exportedMcpServers({ broken: "text" }), { broken: {} });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Billing never sends an end user to the service's web console", () => {
  const billing = billingFrom({
    balance: 12.345,
    subscriptions: [
      { id: 1, groupId: 3, status: "", expiresAt: 5, group: null } as never,
    ],
  });
  assert.deepEqual(billing, {
    plan: null,
    planExpiresAt: null,
    balance: 12.35,
    subscriptions: [{ id: 1, plan: "Plan 3", status: "active", expiresAt: 5 }],
  });
  assert.equal("purchaseUrl" in billing, false);
});
