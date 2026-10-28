import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudEnvironments } from "../../electron/cloud/environments";
import { registerCloudEnvironmentHandlers } from "../../electron/ipc/cloud-environments";
import { initialCloudEnvironment } from "../../shared/cloud-environments-api";
import {
  codeEnvironmentMenu,
  expandedEnvironmentMenu,
} from "../../src/composer/code/code-environment-menu";
import {
  environmentUsage,
  orderRecentEnvironments,
} from "../../src/composer/recent-environments";
import type { Conversation } from "../../shared/types";
import {
  EnvironmentStartCard,
  recentEnvironmentRows,
} from "../../src/composer/EnvironmentStartCard";
import { compilePolicy } from "../../runner/src/net-policy-compile";

test("cloud profiles persist, edit, validate and archive; the built-in default keeps its name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-environments-"));
  try {
    const profiles = new CloudEnvironments(root);
    assert.deepEqual(profiles.list(), [initialCloudEnvironment]);
    const { id, updatedAt, ...input } = initialCloudEnvironment;
    const created = profiles.save({
      ...input,
      name: "CI",
      variables: "NODE_ENV=test",
      setupScript: "npm ci",
    });
    assert.notEqual(created.id, id);
    assert.equal(
      new CloudEnvironments(root).get(created.id).setupScript,
      "npm ci",
    );
    profiles.save({ ...input, id: created.id, name: "Build", network: "none" });
    assert.equal(profiles.get(created.id).network, "none");
    assert.throws(() => profiles.save({ ...input, name: " " }));
    assert.throws(() =>
      profiles.save({ ...input, variables: "not an assignment" }),
    );
    assert.throws(() =>
      profiles.save({ ...input, allowedDomains: ["https://example.com"] }),
    );
    assert.throws(
      () => profiles.get("missing"),
      /Unavailable cloud environment/,
    );
    if (process.platform !== "win32")
      assert.equal(
        fs.statSync(path.join(root, "cloud-environments.json")).mode & 0o777,
        0o600,
      );
    profiles.archive(created.id);
    assert.throws(() => profiles.archive("default"));
    assert.throws(() =>
      profiles.save({ ...input, id: "default", name: "Renamed" }),
    );
    assert.deepEqual(new CloudEnvironments(root).list(), [
      initialCloudEnvironment,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the main-process API implements every profile action, with boundary validation", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-environments-ipc-"),
  );
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    registerCloudEnvironmentHandlers(
      (name, handler) => {
        handlers.set(name, handler);
      },
      { store: { root } } as any,
    );
    assert.equal((await handlers.get("listCloudEnvironments")!()).length, 1);
    const { id, updatedAt, ...input } = initialCloudEnvironment;
    const saved = await handlers.get("saveCloudEnvironment")!({
      ...input,
      name: "New",
    });
    await assert.rejects(handlers.get("archiveCloudEnvironment")!("../escape"));
    await handlers.get("archiveCloudEnvironment")!(saved.id);
    assert.equal((await handlers.get("listCloudEnvironments")!()).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cloud rows select and edit independently, creation is enabled; legacy search appears above ten rows", () => {
  const calls: string[] = [];
  const options = {
    hosts: [],
    statuses: {},
    selected: { kind: "local" as const },
    ssh: false,
    onLocal() {},
    onHost() {},
    onAdd() {},
    onManage() {},
    onEditLocal() {},
    onCloud: (id: string) => calls.push(`select:${id}`),
    onEditCloud: (entry: typeof initialCloudEnvironment) =>
      calls.push(`edit:${entry.id}`),
    onCreateCloud: () => calls.push("create"),
  };
  const entries = codeEnvironmentMenu(options);
  const cloud = entries.find(
    (entry) => "label" in entry && entry.label === "Cloud",
  );
  assert.ok(cloud && "label" in cloud && cloud.submenu);
  const [row, create] = cloud.submenu;
  assert.ok("label" in row && "label" in create);
  assert.ok(!row.disabled && !create.disabled);
  row.onSelect?.();
  row.settings?.onSelect();
  create.onSelect?.();
  assert.deepEqual(calls, ["select:default", "edit:default", "create"]);
  assert.ok(
    !entries.some(
      (entry) => "label" in entry && entry.label === "No environment",
    ),
  );
  assert.equal(cloud.searchable, undefined);
  // The start card: Local's rows, then Cloud, Remote Control and SSH (when it
  // can be used) as submenus; id-named workspaces are left out.
  const expanded = expandedEnvironmentMenu(entries, [
    { label: "Developer", onSelect() {} },
    { label: "a70a78e6-45e6-4a7e-ad58-9369ec2b6208", onSelect() {} },
    { label: "Downloads", onSelect() {} },
  ]);
  assert.deepEqual(
    expanded.map((entry) =>
      "heading" in entry
        ? `# ${entry.heading}`
        : "separator" in entry
          ? "---"
          : `${entry.label}${entry.submenu ? " >" : ""}`,
    ),
    [
      "# Local",
      "This computer",
      "Developer",
      "More >",
      "---",
      "Cloud >",
      "Remote Control >",
    ],
  );
  for (const count of [10, 11]) {
    const cloud = codeEnvironmentMenu({
      ...options,
      environments: Array.from({ length: count }, (_, index) => ({
        ...initialCloudEnvironment,
        id: String(index),
      })),
    })[1];
    assert.ok("label" in cloud);
    assert.equal(
      cloud.searchable,
      count > 10 ? "Search environments…" : undefined,
    );
  }
});

test("recent environments are ordered by use across local, SSH and cloud sessions", () => {
  const conversations = [
    { mode: "code", cwd: "/repo", updatedAt: 3 },
    {
      mode: "code",
      environment: { kind: "space", spaceId: "space" },
      cloudEnvironmentId: "ci",
      updatedAt: 7,
    },
    {
      mode: "code",
      environment: { kind: "ssh", hostId: "host" },
      updatedAt: 5,
    },
    { mode: "code", cwd: "/repo", incognito: true, updatedAt: 100 },
  ] as Conversation[];
  assert.deepEqual(
    orderRecentEnvironments(
      ["folder:/repo", "cloud:ci", "ssh:host"].map((id) => ({ id })),
      conversations,
    ).map((row) => row.id),
    ["cloud:ci", "ssh:host", "folder:/repo"],
  );
});

test("environment usage names the cloud environments a session used, so unused ones stay out of the web home", () => {
  const usage = environmentUsage([
    {
      mode: "code",
      environment: { kind: "space" },
      cloudEnvironmentId: "ci",
      updatedAt: 5,
    },
    { mode: "code", environment: { kind: "space" }, updatedAt: 9 },
    { mode: "chat", cloudEnvironmentId: "other", updatedAt: 7 },
  ] as Conversation[]);
  assert.equal(usage.get("cloud:ci"), 5);
  assert.equal(usage.get("cloud:default"), 9);
  assert.equal(usage.has("cloud:other"), false);
});

test("start card keeps at most three recent environments and retains a selection outside the first three", () => {
  const rows = ["first", "second", "third", "chosen"].map((id) => ({
    id,
    name: id,
    onSelect() {},
  }));
  assert.deepEqual(
    recentEnvironmentRows(rows, "chosen").map((row) => row.id),
    ["first", "second", "chosen"],
  );
  const html = renderToStaticMarkup(
    createElement(EnvironmentStartCard, {
      rows,
      selectedId: "chosen",
      open: false,
      onChoose() {},
    }),
  );
  assert.match(html, /aria-label="Recent environments"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /Choose environment/);
  assert.match(
    html,
    /data-testid="start-card-choose"[^>]*aria-haspopup="menu"/,
  );
  assert.match(
    html,
    /<span>Choose environment<\/span><svg[^>]*aria-hidden="true"/,
  );
  assert.doesNotMatch(html, />third</);
  const empty = renderToStaticMarkup(
    createElement(EnvironmentStartCard, {
      rows: [],
      selectedId: "",
      open: false,
      onChoose() {},
    }),
  );
  assert.match(empty, /data-testid="start-card-choose"/);
  assert.doesNotMatch(empty, /data-testid="start-card-environment"/);
});

test("a cloud environment's egress restriction intersects rather than replaces the runner ceiling", () => {
  const restricted = compilePolicy({
    level: "trusted",
    trustedDomains: ["npmjs.org"],
    restriction: { level: "full" },
  });
  assert.equal(restricted.checkHost("registry.npmjs.org", 443).ok, true);
  assert.equal(restricted.checkHost("example.com", 443).ok, false);
  const custom = compilePolicy({
    level: "full",
    restriction: {
      level: "custom",
      trustedDomains: [],
      customDomains: ["example.com"],
    },
  });
  assert.equal(custom.checkHost("example.com", 443).ok, true);
  assert.equal(custom.checkHost("registry.npmjs.org", 443).ok, false);
  assert.equal(
    compilePolicy({ level: "full", restriction: { level: "none" } }).checkHost(
      "example.com",
      443,
    ).ok,
    false,
  );
});
