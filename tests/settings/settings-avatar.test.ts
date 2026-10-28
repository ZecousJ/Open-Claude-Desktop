import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  avatarCount,
  avatarMaxZoom,
  avatarSource,
  avatarUploadLimit,
  avatarUploadTypes,
  boundAvatarCrop,
  initialAvatarCrop,
  randomAvatar,
  zoomAvatarCrop,
} from "../../shared/avatar";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { publicPreferences } from "../../electron/store/settings-preferences";
import { Store, defaultSettings } from "../../electron/store/store";
import { hasUploads, resolveUploads } from "../../runner/src/attachments";
import { AccountAvatar } from "../../src/settings/AccountAvatar";
import { InstructionsDescription } from "../../src/settings/tabs/Account";
import { avatarVariants } from "../../src/settings/avatar-variants";
import { parseHTML } from "linkedom";

test("avatar variants match the live range, clear to initials, and ship on both hosts", () => {
  assert.equal(avatarCount, 72);
  assert.deepEqual(
    [...avatarVariants].sort((first, second) => first - second),
    Array.from({ length: 72 }, (_, index) => index + 1),
  );
  assert.equal(
    randomAvatar(() => 0),
    1,
  );
  assert.equal(
    randomAvatar(() => 1 - Number.EPSILON),
    72,
  );
  assert.equal(avatarSource({ avatar: 0 }), undefined);
  assert.equal(avatarSource({ avatar: -1 }), undefined);
  assert.equal(avatarSource({ avatar: 73 }), undefined);
  assert.equal(avatarSource({ avatar: 1 }, "./"), "./avatars/1.svg");
  assert.equal(
    avatarSource({ avatar: 1, avatarPhoto: "data:image/png;base64,YQ==" }),
    "data:image/png;base64,YQ==",
  );
  for (let variant = 1; variant <= avatarCount; variant++) {
    const desktop = fs.readFileSync(`public/avatars/${variant}.svg`, "utf8");
    assert.match(desktop, /<svg/);
    assert.equal(
      desktop,
      fs.readFileSync(`public-web/avatars/${variant}.svg`, "utf8"),
    );
  }
});

test("avatar preferences validate and persist in the account's existing settings store", () => {
  for (const value of [-1, 73, 1.5, "1", NaN])
    assert.equal(preferenceFields.avatar.safeParse(value).success, false);
  for (const value of [0, 1, 72])
    assert.equal(preferenceFields.avatar.safeParse(value).success, true);
  for (const value of [
    "https://example.com/avatar.png",
    "data:image/svg+xml;base64,YQ==",
    "data:image/png;base64,<script>",
  ])
    assert.equal(preferenceFields.avatarPhoto.safeParse(value).success, false);
  const photo = "data:image/png;base64,YQ==";
  assert.equal(preferenceFields.avatarPhoto.parse(photo), photo);
  assert.equal(preferenceFields.avatarPhoto.parse(""), "");
  assert.equal(preferenceFields.profilePhotoEnabled.parse(true), true);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-avatar-"));
  try {
    const store = new Store(folder);
    Object.assign(store.settings, {
      avatar: 72,
      avatarPhoto: photo,
      profilePhotoEnabled: true,
    });
    store.flush();
    const restored = new Store(folder);
    assert.deepEqual(publicPreferences(restored.settings), {
      avatar: 72,
      avatarPhoto: photo,
      profilePhotoEnabled: true,
    });
    Object.assign(restored.settings, { avatar: 0, avatarPhoto: "" });
    restored.flush();
    assert.equal(avatarSource(new Store(folder).settings), undefined);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("avatar button is enabled with shuffle and a separate clear badge, or the gated photo menu", () => {
  const render = (avatar: number, profilePhotoEnabled = false) =>
    renderToStaticMarkup(
      createElement(AccountAvatar, {
        settings: { ...defaultSettings, avatar, profilePhotoEnabled },
        name: "Ada Lovelace",
        save: () => {},
      }),
    );
  const initial = render(0);
  assert.match(initial, /aria-label="Randomize avatar"/);
  assert.doesNotMatch(initial, /disabled|Clear avatar|type="file"/);
  const selected = render(72);
  assert.match(selected, /avatars\/72.svg/);
  assert.match(selected, /aria-label="Clear avatar"/);
  assert.doesNotMatch(selected, /disabled/);
  const photo = render(72, true);
  assert.match(
    photo,
    /aria-label="Profile photo" aria-haspopup="menu" aria-expanded="false"/,
  );
  assert.match(
    photo,
    /type="file" accept="image\/png,image\/jpeg,image\/webp"/,
  );
  assert.deepEqual(avatarUploadTypes, [
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);
  assert.equal(avatarUploadLimit, 52428800);
});

test("clicking the avatar saves a variant and clearing restores initials", async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  const values = {
    window,
    document: window.document,
    navigator: { userAgent: "node" },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const root = createRoot(window.document.querySelector("main")!);
  let settings = { ...defaultSettings };
  const patches: Partial<typeof settings>[] = [];
  const render = () =>
    root.render(
      createElement(AccountAvatar, {
        settings,
        name: "Ada Lovelace",
        save: (patch) => {
          patches.push(patch);
          settings = { ...settings, ...patch };
          render();
        },
      }),
    );
  try {
    await act(async () => render());
    await act(async () =>
      window.document
        .querySelector<HTMLButtonElement>('[aria-label="Randomize avatar"]')!
        .click(),
    );
    assert.ok(settings.avatar! >= 1 && settings.avatar! <= 72);
    assert.equal(patches.length, 1);
    assert.equal(
      window.document.querySelector("img")?.getAttribute("src"),
      `/avatars/${settings.avatar}.svg`,
    );
    await act(async () =>
      window.document
        .querySelector<HTMLButtonElement>('[aria-label="Clear avatar"]')!
        .click(),
    );
    assert.deepEqual(patches[1], { avatar: 0, avatarPhoto: "" });
    assert.equal(window.document.querySelector("img"), null);
    assert.equal(
      window.document.querySelector(".settings-avatar")?.textContent,
      "AL",
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("photo crop uses the live square, bounds, 256px minimum, and maximum 4x zoom", () => {
  const crop = initialAvatarCrop(1600, 1200);
  assert.deepEqual(crop, { x: 200, y: 0, size: 1200 });
  assert.equal(avatarMaxZoom(1600, 1200), 4);
  assert.equal(avatarMaxZoom(512, 1024), 2);
  assert.equal(avatarMaxZoom(100, 200), 1);
  assert.deepEqual(zoomAvatarCrop(crop, 1600, 1200, 2), {
    x: 500,
    y: 300,
    size: 600,
  });
  assert.deepEqual(
    boundAvatarCrop({ x: -500, y: 10000, size: 1 }, 1600, 1200),
    { x: 0, y: 900, size: 300 },
  );
  assert.deepEqual(zoomAvatarCrop(crop, 1600, 1200, 0.5), crop);
});

test("runner resolves large avatar photo uploads to validated settings strings", async () => {
  const photo =
    "data:image/png;base64," + "YQ==".repeat(100000).replace(/=/g, "");
  const args = [{ avatarPhoto: { $avatarPhoto: { $upload: "photo1" } } }];
  assert.equal(hasUploads(args), true);
  const resolved = await resolveUploads(args, async () =>
    new TextEncoder().encode(photo),
  );
  assert.deepEqual(resolved, [{ avatarPhoto: photo }]);
  await assert.rejects(
    resolveUploads(args, async () =>
      new TextEncoder().encode("data:image/svg+xml;base64,YQ=="),
    ),
    /not valid/,
  );
  await assert.rejects(
    resolveUploads(args, async () => new Uint8Array(13981041)),
    /too large/,
  );
});

test("instructions use the live merged-chat cross-account copy and exact links", () => {
  const markup = renderToStaticMarkup(createElement(InstructionsDescription));
  assert.match(markup, /associated accounts across chats within/);
  assert.doesNotMatch(markup, /across chats and Cowork/);
  assert.match(
    markup,
    /href="\/help\/usage-policy"/,
  );
  assert.match(
    markup,
    /href="\/help\/personalization"/,
  );
  assert.match(markup, /Claudex usage policy/);
  assert.match(markup, />Learn more<\/a><\/span>$/);
});
