import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listProjectFolder,
  readProjectFile,
  resolveInside,
  searchProjectFiles,
  projectFileLimit,
} from "../../electron/projects/project-files";
import {
  onFilesContentSearch,
  requestFilesContentSearch,
} from "../../src/files/files-search";
import { closeTabs, contentMatchPreview } from "../../src/files/FilesPanel";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("content results highlight literal, case-insensitive hits without interpreting markup or regex", () => {
  const render = (text: string, query: string) =>
    renderToStaticMarkup(
      createElement("div", null, contentMatchPreview(text, query)),
    );
  assert.equal(
    render("Needle then needle", "needle"),
    "<div><mark>Needle</mark> then <mark>needle</mark></div>",
  );
  assert.equal(
    render("a.b <script>", "."),
    "<div>a<mark>.</mark>b &lt;script&gt;</div>",
  );
  assert.equal(render("unchanged", ""), "<div>unchanged</div>");
});

test("Find in Files searches nested text with line numbers, bounded results and no external links", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-find-files-"));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-find-outside-"),
  );
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(
      path.join(root, "src", "app.ts"),
      "no\r\nNeedle one\r\nneedle two\r\n",
    );
    fs.writeFileSync(path.join(root, "many.txt"), "needle\n".repeat(12));
    fs.writeFileSync(path.join(root, ".git", "secret"), "needle");
    fs.writeFileSync(path.join(root, "binary"), "\0needle");
    fs.writeFileSync(
      path.join(root, "large"),
      "needle".repeat(projectFileLimit),
    );
    fs.writeFileSync(path.join(outside, "private"), "needle");
    fs.symlinkSync(outside, path.join(root, "external"));
    fs.symlinkSync(
      path.join(outside, "private"),
      path.join(root, "external-file"),
    );
    const result = await searchProjectFiles(root, " NEEDLE ");
    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 7);
    assert.deepEqual(
      result.matches.filter((match) => match.path === "src/app.ts"),
      [
        { path: "src/app.ts", line: 2, preview: "Needle one" },
        { path: "src/app.ts", line: 3, preview: "needle two" },
      ],
    );
    assert.deepEqual(await searchProjectFiles(root, "  "), {
      matches: [],
      truncated: false,
    });
    assert.deepEqual(await searchProjectFiles(root, "absent"), {
      matches: [],
      truncated: false,
    });
    for (let index = 0; index < 45; index++)
      fs.writeFileSync(path.join(root, `${index}.txt`), "needle\n".repeat(5));
    const capped = await searchProjectFiles(root, "needle");
    assert.equal(capped.matches.length, 200);
    assert.equal(capped.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Find in Files survives lazy pane mounting, targets its session and refocuses existing panes", () => {
  let focused = 0;
  requestFilesContentSearch("session");
  const other = onFilesContentSearch("other", () => {
    throw Error("Wrong session");
  });
  const stop = onFilesContentSearch("session", () => {
    focused++;
  });
  assert.equal(focused, 1);
  requestFilesContentSearch("session");
  assert.equal(focused, 2);
  stop();
  const remount = onFilesContentSearch("session", () => {
    focused++;
  });
  assert.equal(focused, 2);
  remount();
  other();
});

test("the Files pane lists one folder, folders first, and reads text inside the session folder only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-files-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "b.txt"), "hello");
    fs.writeFileSync(path.join(root, "a10.txt"), "x");
    fs.writeFileSync(path.join(root, "a2.txt"), "x");
    fs.writeFileSync(path.join(root, "src", "app.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    const listed = listProjectFolder(root, "");
    assert.deepEqual(
      listed.entries.map((e) => `${e.kind}:${e.path}`),
      [
        "folder:src",
        "file:a2.txt",
        "file:a10.txt",
        "file:b.txt",
        "file:bin.dat",
      ],
    );
    assert.deepEqual(
      listProjectFolder(root, "src").entries.map((e) => e.path),
      ["src/app.ts"],
    );
    assert.equal(readProjectFile(root, "src/app.ts").content, "export {};\n");
    assert.equal(readProjectFile(root, "bin.dat").binary, true);
    assert.throws(() => resolveInside(root, "../etc"), /outside/);
    assert.throws(() => resolveInside(root, "/etc"), /outside/);
    fs.symlinkSync(os.tmpdir(), path.join(root, "out"));
    assert.throws(() => listProjectFolder(root, "out"), /outside/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tab's Close menu keeps the right tabs", () => {
  const tabs = ["a", "b", "c", "d"];
  assert.deepEqual(closeTabs(tabs, "b", "file"), ["a", "c", "d"]);
  assert.deepEqual(closeTabs(tabs, "b", "others"), ["b"]);
  assert.deepEqual(closeTabs(tabs, "b", "right"), ["a", "b"]);
  assert.deepEqual(closeTabs(tabs, "b", "all"), []);
});
