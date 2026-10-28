import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureOutputFiles,
  codeOutputTypes,
} from "../../electron/artifacts/generated-files";
import { GeneratedBlobs } from "../../electron/artifacts/generated-blobs";

test("files a command wrote during the turn are handed over; scripts, hidden folders and known files are not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-outputs-"));
  try {
    const cwd = path.join(root, "workspace");
    fs.mkdirSync(path.join(cwd, ".cache"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
    const old = path.join(cwd, "old.csv");
    fs.writeFileSync(old, "a,b\n");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    const since = Date.now() - 1000;
    fs.writeFileSync(
      path.join(cwd, "adventure.xlsx"),
      Buffer.from("PK\u0003\u0004 xlsx"),
    );
    fs.writeFileSync(path.join(cwd, "make.py"), "print(1)\n");
    fs.writeFileSync(path.join(cwd, ".cache", "hidden.csv"), "x\n");
    fs.writeFileSync(path.join(cwd, "node_modules", "lib.json"), "{}");
    fs.writeFileSync(path.join(cwd, "notes.md"), "# Notes\n");
    const known = new Set([path.resolve(cwd, "notes.md")]);
    const blobs = new GeneratedBlobs(path.join(root, "profile"));
    const files = captureOutputFiles(cwd, since, known, blobs, "outputs-t1");
    assert.deepEqual(
      files.map((file) => file.name),
      ["adventure.xlsx"],
    );
    assert.equal(files[0].id, "outputs-t1:0");
    assert.equal(files[0].operation, "create");
    assert.equal(files[0].state, "ready");
    assert.equal(files[0].blob, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A Code turn hands over the documents it made, not its pages or data.
test("a Code turn hands over only documents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-outputs-"));
  try {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const since = Date.now() - 1000;
    fs.writeFileSync(
      path.join(cwd, "report.docx"),
      Buffer.from("PK\u0003\u0004"),
    );
    fs.writeFileSync(path.join(cwd, "report.html"), "<p>x</p>");
    fs.writeFileSync(path.join(cwd, "data.json"), "{}");
    fs.writeFileSync(path.join(cwd, "make.py"), "print(1)\n");
    const files = captureOutputFiles(
      cwd,
      since,
      new Set(),
      undefined,
      "outputs-t2",
      codeOutputTypes,
    );
    assert.deepEqual(
      files.map((file) => file.name),
      ["report.docx"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
