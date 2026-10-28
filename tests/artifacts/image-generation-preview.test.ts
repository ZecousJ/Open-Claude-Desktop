import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GeneratedBlobs,
  imageType,
  maxGeneratedImageBytes,
} from "../../electron/artifacts/generated-blobs";
import {
  SessionToolView,
  generatedImageArtifact,
} from "../../src/transcript/tools/SessionToolView";
import { pendingArtifacts } from "../../src/transcript/tools/FileChangeView";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fixture image"),
]);

function profile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-imagegen-"));
  const folder = path.join(root, "codex-home", "generated_images", "thread");
  fs.mkdirSync(folder, { recursive: true });
  return { root, folder };
}

test("image types are read from the bytes, not the name", () => {
  assert.equal(imageType(png), "image/png");
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(
    imageType(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")),
    "image/webp",
  );
  assert.equal(imageType(Buffer.from("GIF89a")), undefined);
  assert.equal(imageType(Buffer.from("<svg/>")), undefined);
});

test("a saved picture is snapshotted by digest from the generated images folder only", () => {
  const { root, folder } = profile();
  try {
    const blobs = new GeneratedBlobs(root);
    const file = path.join(folder, "ig_1.png");
    fs.writeFileSync(file, png);
    const snapshot = blobs.snapshotImage(file)!;
    const digest = createHash("sha256").update(png).digest("hex");
    assert.deepEqual(snapshot, {
      digest,
      mime: "image/png",
      bytes: png.byteLength,
    });
    assert.deepEqual(blobs.read(digest), png);

    // Gone: nothing to show.
    assert.equal(blobs.snapshotImage(path.join(folder, "missing.png")), null);
    // Elsewhere on disk, relative, or linked out of the folder: refused.
    const outside = path.join(root, "secret.png");
    fs.writeFileSync(outside, png);
    assert.throws(() => blobs.snapshotImage(outside), /generated images/);
    assert.throws(() => blobs.snapshotImage("ig_1.png"), /generated images/);
    assert.throws(
      () =>
        blobs.snapshotImage(path.join(folder, "..", "..", "..", "secret.png")),
      /generated images/,
    );
    const link = path.join(folder, "link.png");
    fs.symlinkSync(outside, link);
    assert.throws(() => blobs.snapshotImage(link), /generated images/);
    // Not a picture, or too large.
    const text = path.join(folder, "notes.png");
    fs.writeFileSync(text, "not an image");
    assert.throws(() => blobs.snapshotImage(text), /can't be previewed/);
    const large = path.join(folder, "large.png");
    fs.writeFileSync(large, Buffer.alloc(maxGeneratedImageBytes + 1));
    assert.throws(() => blobs.snapshotImage(large), /too large/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the thumbnail opens as a binary file in the viewer", () => {
  assert.deepEqual(
    generatedImageArtifact(
      { digest: "a".repeat(64), mime: "image/png", bytes: 10 },
      "/p/codex-home/generated_images/t/ig_1.png",
      "ig_1.png",
    ),
    {
      id: `generated-image:${"a".repeat(64)}`,
      name: "ig_1.png",
      filename: "ig_1.png",
      language: "text",
      content: "",
      blob: true,
      mime: "image/png",
      bytes: 10,
      sourcePath: "/p/codex-home/generated_images/t/ig_1.png",
      sourceDigest: "a".repeat(64),
      surface: "file",
    },
  );
  // The row itself renders without the preview until the snapshot arrives.
  const html = renderToStaticMarkup(
    createElement(SessionToolView, {
      item: {
        id: "ig",
        type: "imageGeneration",
        status: "completed",
        savedPath: "/p/codex-home/generated_images/t/ig_1.png",
      },
      onArtifact: () => {},
    }),
  );
  assert.match(html, /Generated an image/);
  assert.match(html, /ig_1\.png/);
});

test("HTML and SVG files being written show a generating card, and a failed change a muted one", () => {
  const change = (file: string, running: boolean, state?: string) => ({
    change: { path: file },
    file: state ? { state } : undefined,
    running,
  });
  const writing = pendingArtifacts(
    [change("/w/site/index.html", true), change("/w/app.ts", true)],
    new Set(),
    null,
  );
  assert.equal(writing.length, 1);
  assert.equal(writing[0].artifact.generating, true);
  assert.equal(writing[0].artifact.name, "index.html");
  assert.equal(writing[0].artifact.language, "html");
  assert.equal(writing[0].failure, undefined);

  const failed = pendingArtifacts(
    [change("/w/logo.svg", false)],
    new Set(),
    "failed",
  );
  assert.equal(failed[0].failure, "Couldn't finish this artifact");
  assert.equal(failed[0].artifact.generating, undefined);
  assert.equal(
    pendingArtifacts([change("/w/logo.svg", false)], new Set(), "declined")[0]
      .failure,
    "Changes declined",
  );
  // Finished normally, or already a ready artifact card: nothing extra.
  assert.deepEqual(
    pendingArtifacts([change("/w/logo.svg", false)], new Set(), null),
    [],
  );
  assert.deepEqual(
    pendingArtifacts(
      [change("/w/logo.svg", true)],
      new Set(["/w/logo.svg"]),
      null,
    ),
    [],
  );
});
