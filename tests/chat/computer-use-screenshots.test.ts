import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ScreenshotStore,
  type Transcoder,
} from "../../electron/computer-use/screenshots";
import { screenshotIdOf, screenshotRef } from "../../shared/computer-use";

const edges: number[] = [];
const transcode: Transcoder = (data, _mime, maxEdge) => {
  edges.push(maxEdge);
  return {
    data: Buffer.concat([Buffer.from(`J${maxEdge}:`), data]),
    mimeType: "image/jpeg",
    width: 784,
    height: 490,
    sourceWidth: 1568,
    sourceHeight: 980,
  };
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cu-shots-"));

test("a screenshot is scaled for the model and kept privately on disk", () => {
  const root = path.join(tmp(), "screenshots");
  const store = new ScreenshotStore(root, transcode);
  edges.length = 0;
  const saved = store.save("c1", false, Buffer.from("raw"), "image/png");
  assert.deepEqual(edges, [1568]);
  assert.equal(saved.mimeType, "image/jpeg");
  assert.equal(saved.scale, 2);
  assert.equal(Buffer.from(saved.data, "base64").toString(), "J1568:raw");
  const file = path.join(root, "c1", `${saved.id}.jpg`);
  assert.equal(fs.readFileSync(file, "utf8"), "J1568:raw");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, "c1")).mode & 0o777, 0o700);
  }
  assert.equal(
    store.read(saved.id, "full"),
    `data:image/jpeg;base64,${Buffer.from("J1568:raw").toString("base64")}`,
  );
  const thumb = store.read(saved.id, "thumb")!;
  assert.equal(
    Buffer.from(thumb.split(",")[1], "base64").toString(),
    "J480:J1568:raw",
  );
  assert.ok(store.bytes() >= "J1568:raw".length);
});

test("incognito screenshots stay in memory, only the newest 50", () => {
  const root = path.join(tmp(), "screenshots");
  const store = new ScreenshotStore(root, transcode);
  const ids = Array.from(
    { length: 52 },
    () => store.save("c-incognito", true, Buffer.from("x"), "image/png").id,
  );
  assert.equal(fs.existsSync(root), false);
  assert.equal(store.read(ids[0], "full"), null);
  assert.equal(store.read(ids[1], "full"), null);
  assert.ok(store.read(ids[51], "full"));
  store.deleteConversation("c-incognito");
  assert.equal(store.read(ids[51], "full"), null);
  store.save("c-incognito", true, Buffer.from("x"), "image/png");
  store.clearMemory();
  assert.equal(store.bytes(), 0);
});

test("deleting or pruning conversations removes their screenshots", () => {
  const root = path.join(tmp(), "screenshots");
  const store = new ScreenshotStore(root, transcode);
  const a = store.save("keep", false, Buffer.from("a"), "image/png");
  const b = store.save("gone", false, Buffer.from("b"), "image/png");
  const c = store.save("deleted", false, Buffer.from("c"), "image/png");
  store.deleteConversation("deleted");
  assert.equal(store.read(c.id, "full"), null);
  store.prune(new Set(["keep"]));
  assert.ok(store.read(a.id, "full"));
  assert.equal(store.read(b.id, "full"), null);
  assert.deepEqual(fs.readdirSync(root), ["keep"]);
});

test("ids and conversation names can't reach outside the folder", () => {
  const dir = tmp();
  const root = path.join(dir, "screenshots");
  fs.writeFileSync(path.join(dir, "secret.jpg"), "secret");
  const store = new ScreenshotStore(root, transcode);
  assert.equal(store.read("../secret", "full"), null);
  assert.equal(store.read("not-a-uuid", "full"), null);
  assert.throws(() => store.save("../x", false, Buffer.from("x"), "image/png"));
  store.deleteConversation("..");
  assert.ok(fs.existsSync(path.join(dir, "secret.jpg")));
});

test("the transcript refers to screenshots by reference", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(screenshotRef(id), `claudex-screenshot://${id}`);
  assert.equal(screenshotIdOf(`claudex-screenshot://${id}\n`), id);
  assert.equal(screenshotIdOf("claudex-screenshot://../../etc"), undefined);
  assert.equal(screenshotIdOf("hello"), undefined);
});
