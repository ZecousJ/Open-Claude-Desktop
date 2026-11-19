import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerResources } from "../electron/official-ui/native/resources";
import { searchProjectFiles } from "../electron/projects/project-files";
function setup() {
  let owner = "a", identity = 1, active = true;
  const handlers = new Map<string, any>(); const calls: any[] = [];
  const c: any = { id: "c", cwd: "/work", mode: "code" };
  let source: any = async (name: string, target: unknown) => {
    if (target && typeof target === "object" && "cwd" in target)
      throw Error("Choose the working folder with the folder picker.");
    if (name === "mentionFiles") return [{ path: "a.txt", kind: "file" }];
    if (name === "listProjectFolder") return { entries: [{ path: "a.txt", kind: "file" }], truncated: false };
    if (name === "searchProjectFiles") return { matches: [{ path: "a.txt", line: 1, column: 401, preview: "match" }], truncated: false };
    throw Error(name);
  };
  const call = async (name: string, ...args: any[]) => { calls.push([name, ...args]); return source(name, ...args); };
  const host: any = { ctx: { account: () => owner ? { id: owner } : undefined, sessionIdentity: () => identity,
    isCurrent: () => active, call, localCall: call, localListConversations: async () => [c], localLoadConversation: async () => c },
    on(name: string, fn: any) { handlers.set(name, fn); return host; } };
  registerResources(host);
  return { call: (name: string, ...args: any[]) => handlers.get("Resources." + name)(...args), calls, c,
    source: (fn: any) => source = fn, switch: () => { owner = "b"; identity++; }, reactivate: () => identity++, retire: () => active = false };
}
test("complete project index exceeds mention cap and hashes actual changed contents", async () => {
  const h = setup(); let count = 70;
  h.source(async () => ({ entries: Array.from({ length: count }, (_, i) => ({ path: `${i}.txt`, kind: "file" })), truncated: false }));
  await h.call("setFocusedCwd", "/work");
  const a = await h.call("getProjectFileListIfChanged");
  assert.equal(a.paths.split("\n").length, 70);
  assert.deepEqual(await h.call("getProjectFileListIfChanged", a.version), {
    version: a.version, paths: null,
  });
  count++;
  assert.notEqual((await h.call("getProjectFileListIfChanged", a.version)).version, a.version);
  assert.ok(h.calls.every(c => c[0] === "listProjectFolder" && c[1] === "c"));
});
test("recursive index preserves folders and rejects invalid/truncated source", async () => {
  const h = setup(); await h.call("setFocusedCwd", "/work");
  h.source(async (_: string, _id: string, folder: string) => {
    assert.ok(folder === "" || folder === "src");
    return {
      entries: folder
        ? [{ path: "src/a.ts", kind: "file" }]
        : [{ path: "src", kind: "folder" }, { path: "node_modules", kind: "folder" }],
      truncated: false,
    };
  });
  assert.equal(await h.call("getProjectFileList"), "src/\nsrc/a.ts");
  for (const value of [{ entries: [], truncated: true }, { entries: [{ path: "../secret", kind: "file" }], truncated: false }]) {
    h.source(async () => value); await assert.rejects(h.call("getProjectFileList"));
  }
});
test("unknown draft cwd and remote sessions cannot authorize reads", async () => {
  const h = setup(); await h.call("setFocusedCwd", "/other");
  await assert.rejects(h.call("getProjectFileList"), /folder picker/);
  assert.deepEqual(h.calls, [["listProjectFolder", { cwd: "/other" }, ""]]);
  await h.call("setFocusedCwd", "/work"); h.c.environment = { kind: "ssh" };
  await assert.rejects(h.call("searchFileContents", "q"), /folder picker/);
  await h.call("setFocusedRemoteTarget"); await assert.rejects(h.call("fetchMentionOptions", ""), /Remote/);
});
test("late reads reject account activation, focus changes and retired adapters", async () => {
  for (const action of ["switch", "reactivate", "retire", "focus"] as const) {
    const h = setup(); await h.call("setFocusedCwd", "/work"); let done!: (x: any) => void;
    h.source(() => new Promise(r => done = r));
    const pending = h.call("fetchMentionOptions", "a");
    if (action === "focus") await h.call("setFocusedCwd", "/other"); else h[action]();
    done([{ path: "a.txt", kind: "file" }]); await assert.rejects(pending);
    await assert.rejects(h.call("handleMentionSelect", "file-/work/a.txt"));
  }
});
test("mention service failures and forged suggestion IDs do not turn into empty successes", async () => {
  const h = setup(); await h.call("setFocusedCwd", "/work");
  assert.equal((await h.call("fetchMentionOptions", "a"))[0].label, "a.txt");
  assert.deepEqual(await h.call("handleMentionSelect", "file-/work/a.txt"), { chipText: "a.txt" });
  await assert.rejects(h.call("handleMentionSelect", "file-/secret"), /expired/);
  h.source(async () => { throw Error("permission denied"); });
  await assert.rejects(h.call("fetchMentionOptions", "a"), /permission denied/);
  await assert.rejects(h.call("fetchMentionOptions", "", "windows"), /unavailable/);
});
test("strict search delegates only owned IDs, validates limits and preserves real source column", async () => {
  const h = setup(); await h.call("setFocusedCwd", "/work");
  assert.equal((await h.call("searchFileContents", "match", 10))[0].column, 401);
  assert.deepEqual(h.calls[0], ["searchProjectFiles", "c", "match", {
    strict: true, maxResults: 10, filesPane: true,
  }]);
  for (const n of [0, -1, 242, 1.5]) await assert.rejects(h.call("searchFileContents", "x", n));
  h.source(async () => ({ matches: [], truncated: true })); await assert.rejects(h.call("searchFileContents", "x"), /truncated/);
  h.source(async () => { throw Error("read failed"); }); await assert.rejects(h.call("searchFileContents", "x"), /read failed/);
});
test("original content search uses the real project, its 241-row cap and search controls", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resources-content-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "设计笔记.txt"), "中文 needle-42 and needle-56\nNeedle\nneedles\n");
  fs.writeFileSync(path.join(root, "00-many.txt"), Array(250).fill("many hits").join("\n"));
  for (let index = 1; index <= 40; index++) {
    fs.writeFileSync(path.join(root, `sample-${index}.txt`), Array(6).fill("many hits").join("\n"));
  }
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "dependency.txt"), "dependency-only marker");
  const h = setup();
  h.c.cwd = root;
  h.source(async (method: string, _id: string, query: string, options: object) => {
    assert.equal(method, "searchProjectFiles");
    return searchProjectFiles(root, query, options);
  });
  await h.call("setFocusedCwd", root);
  const many = await h.call("searchFileContents", "many hits", 241);
  assert.equal(many.length, 241);
  assert.equal(many.filter((row: any) => row.relativePath === "00-many.txt").length, 6);
  assert.ok(many.some((row: any) => row.relativePath === "sample-9.txt"));
  assert.deepEqual(await h.call("searchFileContents", "dependency-only marker", 241), []);
  assert.equal((await h.call("searchFileContents", "中文", 241))[0].relativePath, "设计笔记.txt");
  assert.deepEqual(await h.call("searchFileContents", "no fixture match", 241), []);
  const search = (query: string, options: object) =>
    h.call("searchFileContentsWithOptions", { query, options, maxResults: 241 });
  assert.deepEqual((await search("Needle", { matchCase: true, wholeWord: true })).matches.map((row: any) => row.line), [2]);
  assert.deepEqual((await search("needle", { wholeWord: true })).matches.map((row: any) => row.line), [1, 2]);
  const regexp = await search("needle-[0-9]+", { regexp: true });
  assert.equal(regexp.patternRefused, false);
  assert.deepEqual(regexp.matches[0].previewMatches, [{ start: 3, end: 12 }, { start: 17, end: 26 }]);
  assert.deepEqual(await search("[", { regexp: true }), { matches: [], patternRefused: true });

  const marker = "F103-long-marker";
  const line = JSON.stringify({
    prefix: "x".repeat(1500), value: marker, again: marker, tail: "z".repeat(1500),
  });
  fs.writeFileSync(path.join(root, "data.json"), line);
  const [literal] = await h.call("searchFileContents", marker, 241);
  const [longRegexp] = (await search(marker, { regexp: true })).matches;
  assert.equal(longRegexp.relativePath, "data.json");
  assert.equal(longRegexp.column, line.indexOf(marker) + 1);
  assert.equal(longRegexp.column, literal.column);
  assert.equal(longRegexp.preview.length, 1000);
  assert.equal(longRegexp.preview, literal.preview);
  assert.deepEqual(
    longRegexp.previewMatches.map(({ start, end }: { start: number; end: number }) =>
      longRegexp.preview.slice(start, end)),
    [marker, marker],
  );
});
test("strict real temporary file search reports full column and errors, old default is compatible", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resources-strict-"));
  try {
    fs.writeFileSync(path.join(root, "text"), "a".repeat(400) + "needle");
    fs.symlinkSync("/not-a-real-resource-target", path.join(root, "link"));
    const strict = await searchProjectFiles(root, "needle", { strict: true });
    assert.equal(strict.matches[0].column, 401); assert.equal(strict.matches.length, 1);
    assert.equal((await searchProjectFiles(root, "needle")).matches[0].column, undefined);
    await assert.rejects(searchProjectFiles(path.join(root, "missing"), "needle", { strict: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("strict search does not silently drop folder failures or a sixth matching line", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resources-partial-"));
  try {
    fs.writeFileSync(path.join(root, "text"), Array(6).fill("needle").join("\n"));
    assert.equal((await searchProjectFiles(root, "needle", { strict: true })).matches.length, 6);
    assert.equal((await searchProjectFiles(root, "needle")).matches.length, 5);
    const original = fs.promises.readdir;
    const actualRoot = fs.realpathSync(root);
    t.mock.method(fs.promises, "readdir", async (...args: any[]) => {
      if (String(args[0]) === actualRoot) throw Error("simulated read failure");
      return (original as any)(...args);
    });
    await assert.rejects(searchProjectFiles(root, "needle", { strict: true }), /folder could not/);
    assert.deepEqual(await searchProjectFiles(root, "needle"), { matches: [], truncated: false });
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); }
});
