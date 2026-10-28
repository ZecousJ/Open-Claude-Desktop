import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  imageBlob,
  imageFileName,
  pngBlob,
  copyImage,
  saveImage,
} from "../../src/ui/image-operations";
import { copyNativeImage } from "../../electron/app/image-clipboard";
import { writeImageClipboard } from "../../src-web/bridge/browser-env";
import {
  AttachmentList,
  MessageAttachments,
  attachedImageLabel,
} from "../../src/composer/Attachments";
import {
  ConversationServicesContext,
  desktopConversationServices,
} from "../../src/conversation/ConversationServices";
import { codeFailure } from "../../src/transcript/CodeTurnError";
import type { Attachment } from "../../shared/types";
import { setLocale } from "../../src/i18n";
import { PastedCard } from "../../src/composer/PastedCard";

const png = "data:image/png;base64,iVBORw0KGgo=";
const attachment: Attachment = {
  id: "a",
  kind: "image",
  name: "photo.png",
  path: "/photo.png",
  size: 8,
};

function globals(context: TestContext, values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test("saving images keeps recognized names and uses the original format otherwise", async () => {
  assert.equal(imageFileName("image/jpeg", "photo.JPEG", 123), "photo.JPEG");
  assert.equal(imageFileName("image/jpeg", "caption", 123), "image-123.jpg");
  assert.equal(imageFileName("image/webp", undefined, 123), "image-123.webp");
  assert.equal(
    imageFileName("image/jpeg;charset=binary", undefined, 123),
    "image-123.jpg",
  );
  assert.equal(imageFileName("image/unknown", undefined, 123), "image-123.png");
  const blob = await imageBlob(png);
  assert.equal(blob.type, "image/png");
  assert.strictEqual(await pngBlob(blob), blob);
});

test("native copying accepts only bounded PNG data and rejects undecodable images", async () => {
  const image = { isEmpty: () => false };
  let copied = false;
  await copyNativeImage(
    png,
    (data) => {
      assert.equal(data, png);
      return image;
    },
    (value) => {
      assert.equal(value, image);
      copied = true;
    },
  );
  assert.equal(copied, true);
  for (const invalid of [
    null,
    "https://example.com/image.png",
    "data:text/html;base64,abcd",
    "data:image/png;base64,!!!",
    "x".repeat(32_000_001),
  ])
    await assert.rejects(
      copyNativeImage(
        invalid,
        () => {
          throw new Error("Must not decode invalid input");
        },
        () => {},
      ),
      (error: Error) => error.message !== "Must not decode invalid input",
    );
  await assert.rejects(
    copyNativeImage(
      png,
      () => ({ isEmpty: () => true }),
      () => {},
    ),
    /Image decode failed/,
  );
  await assert.rejects(
    copyNativeImage(
      png,
      () => image,
      () => {
        throw new Error("Clipboard refused");
      },
    ),
    /Clipboard refused/,
  );
});

test("browser copying places a PNG promise on the clipboard before fetching completes", async (context) => {
  let bytes: Promise<Blob> | undefined;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ClipboardItem",
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        write: async (items: { data: Record<string, Promise<Blob>> }[]) => {
          bytes = items[0].data["image/png"];
        },
      },
    },
  });
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: class {
      constructor(public data: Record<string, Promise<Blob>>) {}
    },
  });
  context.after(() => {
    for (const [name, descriptor] of [
      ["navigator", navigatorDescriptor],
      ["ClipboardItem", clipboardDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  await writeImageClipboard(png);
  assert.ok(bytes instanceof Promise);
  assert.equal((await bytes).type, "image/png");
});

test("JPEG clipboard conversion uses natural dimensions and releases its object URL", async (context) => {
  const revoked: string[] = [];
  const converted = new Blob(["png"], { type: "image/png" });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (
        image: { naturalWidth: number; naturalHeight: number },
        left: number,
        top: number,
      ) => {
        assert.equal(image.naturalWidth, 40);
        assert.equal(image.naturalHeight, 20);
        assert.deepEqual([left, top], [0, 0]);
      },
    }),
    toBlob: (callback: BlobCallback, type: string) => {
      assert.equal(type, "image/png");
      callback(converted);
    },
  };
  globals(context, {
    Image: class {
      naturalWidth = 40;
      naturalHeight = 20;
      onload?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
    document: { createElement: () => canvas },
  });
  context.mock.method(URL, "createObjectURL", () => "blob:jpeg");
  context.mock.method(URL, "revokeObjectURL", (url: string) =>
    revoked.push(url),
  );
  assert.strictEqual(
    await pngBlob(new Blob(["jpeg"], { type: "image/jpeg" })),
    converted,
  );
  assert.deepEqual([canvas.width, canvas.height], [40, 20]);
  assert.deepEqual(revoked, ["blob:jpeg"]);
});

test("saving downloads original image bytes and releases the download URL", async (context) => {
  let saved: Blob | undefined;
  let clicked = false;
  let removed = false;
  let cleanup: (() => void) | undefined;
  const link = {
    href: "",
    download: "",
    click: () => {
      clicked = true;
    },
  };
  globals(context, {
    document: {
      createElement: () => link,
      body: {
        appendChild: () => {},
        removeChild: () => {
          removed = true;
        },
      },
    },
    setTimeout: (callback: () => void, delay: number) => {
      assert.equal(delay, 1000);
      cleanup = callback;
      return 0;
    },
  });
  context.mock.method(URL, "createObjectURL", (blob: Blob) => {
    saved = blob;
    return "blob:download";
  });
  const revoke = context.mock.method(URL, "revokeObjectURL", () => {});
  await saveImage("data:image/jpeg;base64,aGVsbG8=", "photo.jpg");
  assert.equal(saved?.type, "image/jpeg");
  assert.equal(await saved?.text(), "hello");
  assert.equal(link.href, "blob:download");
  assert.equal(link.download, "photo.jpg");
  assert.ok(clicked && removed);
  assert.equal(revoke.mock.callCount(), 0);
  cleanup!();
  assert.equal(revoke.mock.callCount(), 1);
});

test("desktop image copying sends PNG data to the native bridge", async (context) => {
  let copied: string | undefined;
  globals(context, {
    window: {
      desktop: {
        copyImage: async (dataUrl: string) => {
          copied = dataUrl;
        },
      },
    },
    FileReader: class {
      result = png;
      onload?: () => void;
      readAsDataURL(blob: Blob) {
        assert.equal(blob.type, "image/png");
        queueMicrotask(() => this.onload?.());
      }
    },
  });
  await copyImage(png);
  assert.equal(copied, png);
});

test("attached images announce their index, loading and uploading states", () => {
  assert.equal(attachedImageLabel(0), "View attached image 1");
  assert.equal(
    attachedImageLabel(2, true),
    "View attached image 3 (uploading)",
  );
  const render = (ready: boolean, sent = false) =>
    renderToStaticMarkup(
      createElement(
        ConversationServicesContext.Provider,
        {
          value: {
            ...desktopConversationServices,
            attachmentPreviewSync: () => (ready ? png : null),
          },
        },
        sent
          ? createElement(MessageAttachments, { attachments: [attachment] })
          : createElement(AttachmentList, {
              attachments: [attachment],
              pending: [{ key: "pending", name: "new.png", image: true }],
            }),
      ),
    );
  for (const sent of [false, true]) {
    assert.match(render(false, sent), /Loading attached image photo.png/);
    assert.match(render(true, sent), /View attached image 1/);
    assert.doesNotMatch(render(false, sent), /attachment-tile-text/);
  }
  assert.match(render(false), /View attached image 2 \(uploading\)/);
  assert.match(render(false), /Uploading image/);
});

test("oversized-image errors explain the recovery route actually available", () => {
  assert.equal(
    codeFailure("image exceeds the dimension limit", true).hint,
    "This image is too large to send. Rewind to remove it and try again.",
  );
  assert.equal(
    codeFailure("image too large", false).hint,
    "This image is too large to send. Start a new session to continue.",
  );
  assert.equal(codeFailure("file too large").headline, "Something went wrong");
});

test("composer tiles keep named remove controls and translate their labels", async () => {
  await setLocale("de-DE");
  try {
    const markup = renderToStaticMarkup(
      createElement(AttachmentList, {
        attachments: [
          attachment,
          { ...attachment, id: "file", kind: "document", name: "notes.txt" },
        ],
        pending: [],
        onRemove() {},
      }),
    );
    assert.match(markup, /aria-label="photo.png entfernen"/);
    assert.match(markup, /aria-label="notes.txt entfernen"/);
    assert.doesNotMatch(markup, /aria-label="Remove |aria-label="Remove file"/);
    assert.match(
      renderToStaticMarkup(
        createElement(PastedCard, { name: "Notes", onRemove() {} }),
      ),
      /aria-label="Notes entfernen"/,
    );
  } finally {
    await setLocale("en-US");
  }
});
