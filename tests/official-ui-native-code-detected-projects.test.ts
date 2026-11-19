import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { registerCodeDetectedProjects } from "../electron/official-ui/native/code-detected-projects";

const sharedVscode = ".vscode-shared/sharedStorage/state.vscdb";
const sharedCursor = ".cursor-shared/sharedStorage/state.vscdb";
const legacyVscode =
  "Library/Application Support/Code/User/globalStorage/state.vscdb";
const legacyCursor =
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb";
const zedDatabase = "Library/Application Support/Zed/db/0-stable/db.sqlite";
const vsHistoryKey = "history.recentlyOpenedPathsList";
const moment = (seconds: number) =>
  new Date(1_700_000_000_000 + seconds * 1_000);

async function fixture(t: TestContext) {
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "f107-project-detection-")),
  );
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const handlers = new Map<string, () => Promise<unknown>>();
  const logs: unknown[][] = [];
  registerCodeDetectedProjects(
    {
      on: (operation, handler) => handlers.set(operation, handler),
      ctx: { log: (...fields) => logs.push(fields) },
    },
    home,
  );
  const detect = handlers.get("LocalSessions.getDetectedProjects");
  assert.ok(detect);
  return { home, detect, logs };
}

async function file(
  home: string,
  relative: string,
  contents: string,
  seconds = 1,
) {
  const filename = path.join(home, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
  await fs.utimes(filename, moment(seconds), moment(seconds));
  return filename;
}

async function openDatabase(home: string, relative: string) {
  const filename = path.join(home, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  return new DatabaseSync(filename);
}

async function vscodeHistory(
  home: string,
  relative: string,
  value: string,
  wal = false,
) {
  const db = await openDatabase(home, relative);
  if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(vsHistoryKey, value);
  if (wal) return db;
  db.close();
}

function folderUri(home: string, relative: string) {
  return { folderUri: pathToFileURL(path.join(home, relative)).href };
}

test("detected projects merge editor histories and home folders by canonical path and activity", async (t) => {
  const { home, detect } = await fixture(t);
  await file(home, "Developer/checkout/.git/index", "", 20);
  await file(home, "Developer/checkout/package.json", "{}", 90);
  await file(home, "Developer/new-project/go.mod", "", 60);
  await file(home, "Developer/.hidden/package.json", "{}", 99);
  await file(home, "Developer/container/deeper/package.json", "{}", 98);
  await file(home, "Developer/loose-file", "", 97);
  await file(home, "folder archive/project/.git", "gitdir: /tmp/example", 5);
  await fs.mkdir(path.join(home, "repos"));
  await fs.symlink(
    path.join(home, "folder archive/project"),
    path.join(home, "repos/alias"),
    "junction",
  );
  await fs.symlink(
    path.join(home, "Developer/checkout"),
    path.join(home, "checkout-link"),
    "junction",
  );
  await fs.mkdir(path.join(home, "other/plain folder"), { recursive: true });
  await fs.mkdir(path.join(home, "other/unused-vscode"), { recursive: true });
  await file(home, "other/zed-project/pyproject.toml", "", 40);
  const vscode = await vscodeHistory(
    home,
    sharedVscode,
    JSON.stringify({
      entries: [
        folderUri(home, "checkout-link"),
        folderUri(home, "Developer/loose-file"),
        folderUri(home, "missing"),
        { folderUri: "vscode-remote://ssh-remote+fixture/project" },
        { folderUri: "file://host.invalid/project" },
        { fileUri: folderUri(home, "other/unused-vscode").folderUri },
      ],
    }),
    true,
  );
  try {
    await vscodeHistory(
      home,
      legacyVscode,
      JSON.stringify({ entries: [folderUri(home, "other/unused-vscode")] }),
    );
    await vscodeHistory(home, sharedCursor, " \n");
    await vscodeHistory(
      home,
      legacyCursor,
      JSON.stringify({ entries: [folderUri(home, "other/plain folder")] }),
    );
    const zed = await openDatabase(home, zedDatabase);
    try {
      zed.exec("CREATE TABLE workspaces (paths TEXT, timestamp INTEGER)");
      zed
        .prepare("INSERT INTO workspaces VALUES (?, ?)")
        .run(
          [
            path.join(home, "Developer/checkout"),
            path.join(home, "other/zed-project"),
            "relative/path",
            "",
          ].join("\n"),
          1,
        );
    } finally {
      zed.close();
    }
    assert.deepEqual(await detect(), [
      {
        path: path.join(home, "Developer/new-project"),
        name: "new-project",
        source: "scan",
        lastActivity: +moment(60),
      },
      {
        path: path.join(home, "other/zed-project"),
        name: "zed-project",
        source: "zed",
        lastActivity: +moment(40),
      },
      {
        path: path.join(home, "Developer/checkout"),
        name: "checkout",
        source: "vscode",
        lastActivity: +moment(20),
      },
      {
        path: path.join(home, "folder archive/project"),
        name: "alias",
        source: "scan",
        lastActivity: +moment(5),
      },
      {
        path: path.join(home, "other/plain folder"),
        name: "plain folder",
        source: "cursor",
        lastActivity: 0,
      },
    ]);
  } finally {
    vscode?.close();
  }
});

test("a failed editor source preserves the other results and editor limits apply before filtering", async (t) => {
  const { home, detect, logs } = await fixture(t);
  await file(home, sharedVscode, "invalid database");
  await fs.mkdir(path.join(home, "other/fallback"), { recursive: true });
  await vscodeHistory(
    home,
    legacyVscode,
    JSON.stringify({ entries: [folderUri(home, "other/fallback")] }),
  );
  await fs.mkdir(path.join(home, "other/cursor-over-limit"), {
    recursive: true,
  });
  await vscodeHistory(
    home,
    sharedCursor,
    JSON.stringify({
      entries: [
        ...Array.from({ length: 50 }, () => ({
          folderUri: "vscode-remote://ssh-remote+fixture/project",
        })),
        folderUri(home, "other/cursor-over-limit"),
      ],
    }),
  );
  await file(home, "source/repos/scan-project/dune-project", "", 30);
  await file(home, "other/zed-first/Cargo.toml", "", 20);
  await file(home, "other/zed-over-limit/setup.py", "", 70);
  const zed = await openDatabase(home, zedDatabase);
  try {
    zed.exec("CREATE TABLE workspaces (paths TEXT, timestamp INTEGER)");
    const addWorkspace = zed.prepare("INSERT INTO workspaces VALUES (?, ?)");
    addWorkspace.run(path.join(home, "other/zed-over-limit"), 1);
    addWorkspace.run(
      [
        path.join(home, "other/zed-first"),
        ...Array.from({ length: 49 }, () => "relative/path"),
      ].join("\n"),
      2,
    );
  } finally {
    zed.close();
  }
  assert.deepEqual(await detect(), [
    {
      path: path.join(home, "source/repos/scan-project"),
      name: "scan-project",
      source: "scan",
      lastActivity: +moment(30),
    },
    {
      path: path.join(home, "other/zed-first"),
      name: "zed-first",
      source: "zed",
      lastActivity: +moment(20),
    },
  ]);
  assert.ok(logs.some((fields) => fields.includes("vscode")));
});

test("the first scan caches its result and an expired read serves it while refreshing", async (t) => {
  const { home, detect } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: moment(0) });
  assert.deepEqual(await Promise.all([detect(), detect()]), [[], []]);
  await file(home, "Developer/after-scan/package.json", "{}", 12);
  t.mock.timers.tick(30 * 60_000);
  assert.deepEqual(await detect(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(await Promise.all([detect(), detect()]), [[], []]);
  const deadline = performance.now() + 3_000;
  let updated = await detect();
  while (
    Array.isArray(updated) &&
    updated.length === 0 &&
    performance.now() < deadline
  ) {
    await delay(5);
    updated = await detect();
  }
  assert.deepEqual(updated, [
    {
      path: path.join(home, "Developer/after-scan"),
      name: "after-scan",
      source: "scan",
      lastActivity: +moment(12),
    },
  ]);
});
