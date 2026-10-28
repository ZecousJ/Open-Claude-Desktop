import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { AccountTab, accountPhotoLimit } from "../../src/settings/tabs/Account";
import AvatarDialogs from "../../src/settings/AvatarDialogs";
import {
  avatarLabel,
  avatarVariants,
} from "../../src/settings/avatar-variants";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { defaultSettings } from "../../electron/store/store";
import type { AccountProfile } from "../../shared/settings-api";
import type { DeviceInfo } from "../../shared/remote-devices";
import type { DesktopAPI, Settings } from "../../shared/types";
import type { TabProps } from "../../src/settings/context";

test("avatar popup renders the measured title, palette, grid and footer styles", async () => {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const css = [
    "styles/00-foundation.css",
    "styles/50-controls-menus.css",
    "styles/80-dialogs-responsive.css",
    "settings/settings.css",
    "settings/avatar-dialogs.css",
  ]
    .map((path) =>
      readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8"),
    )
    .join("\n");
  let markup = "";
  await withDOM(async ({ document, render }) => {
    await render(
      createElement(AvatarDialogs, {
        current: 0,
        busy: false,
        onClose() {},
        async onSave() {},
      }),
    );
    markup = document.body.innerHTML;
  });
  const page = new JSDOM(
    `<html data-theme="dark"><head><style>${css}</style></head><body>${markup}</body></html>`,
    { virtualConsole: new VirtualConsole() },
  );
  try {
    const doc = page.window.document;
    const style = (element: Element) => page.window.getComputedStyle(element);
    const dialog = doc.querySelector(".settings-avatar-dialog")!;
    assert.equal(style(dialog).width, "520px");
    assert.equal(style(dialog).borderRadius, "12px");
    assert.equal(style(dialog).backgroundColor, "rgb(32, 32, 31)");
    const title = dialog.querySelector("h2")!;
    assert.equal(title.textContent, "Choose an avatar");
    // The title reads the text token (jsdom leaves var() unresolved).
    assert.equal(style(title).color, "var(--text)");
    assert.equal(
      style(doc.documentElement).getPropertyValue("--text").trim(),
      "#f0efec",
    );
    assert.equal(style(title).fontWeight, "580");
    assert.equal(
      dialog.querySelector(".settings-avatar-description")?.textContent,
      "Use one of these instead of a photo.",
    );
    const grid = dialog.querySelector(".settings-avatar-grid")!;
    assert.equal(style(grid).rowGap, "8px");
    assert.equal(grid.querySelectorAll('[role="radio"]').length, 72);
    for (const button of dialog.querySelectorAll(
      ".settings-avatar-footer button",
    )) {
      assert.equal(style(button).height, "32px");
      assert.equal(style(button).fontSize, "14px");
      assert.equal(style(button).lineHeight, "20px");
    }
    doc.documentElement.dataset.theme = "light";
    assert.equal(style(dialog).backgroundColor, "rgb(255, 255, 255)");
    assert.equal(style(title).color, "rgb(11, 11, 11)");
  } finally {
    page.window.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const profile: AccountProfile = {
  kind: "local",
  fullName: "Account name",
  email: "name@example.test",
  canDelete: true,
};
const props = (patch: Partial<TabProps> = {}): TabProps => ({
  settings: { ...defaultSettings, name: "Local name" },
  save: async () => true,
  platform: "darwin",
  engine: { state: "ready" } as TabProps["engine"],
  onError() {},
  goTo() {},
  ...patch,
});

function handlers<T>(element: Element): T {
  const key = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  )!;
  assert.ok(key, "mounted React control");
  return (element as unknown as Record<string, T>)[key];
}

async function withDOM(
  run: (context: {
    document: Document;
    render(element: ReactElement): Promise<void>;
    click(selector: string): Promise<void>;
    replaceBridge(patch: Partial<DesktopAPI>): void;
  }) => Promise<void>,
  bridge: Partial<DesktopAPI> = {},
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.desktop = {
    accountProfile: async () => profile,
    listCoworkDevices: async () => [],
    activeSessions: async () => null,
    ...bridge,
  } as DesktopAPI;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 40,
    bottom: 40,
    width: 40,
    height: 40,
    toJSON() {},
  });
  const values = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    navigator: { userAgent: "node" },
    innerWidth: 1440,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.entries(values).forEach(([key, value]) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    }),
  );
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await run({
      document: document as unknown as Document,
      render: async (element) => {
        await act(async () => root.render(element));
      },
      click: async (selector) => {
        const target = document.querySelector<HTMLButtonElement>(selector);
        assert.ok(target, selector);
        await act(async () => target.click());
      },
      replaceBridge: (patch) => {
        window.desktop = { ...window.desktop, ...patch };
      },
    });
  } finally {
    await act(() => root.unmount());
    saved.forEach((descriptor, key) =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : Reflect.deleteProperty(globalThis, key),
    );
  }
}

async function editInput(document: Document, label: string, value: string) {
  const input = document.querySelector(`input[aria-label="${label}"]`)!;
  assert.ok(input);
  await act(async () => handlers<{ onFocus(): void }>(input).onFocus());
  await act(async () =>
    handlers<{ onChange(event: unknown): void }>(input).onChange({
      target: { value },
    }),
  );
  await act(async () => handlers<{ onBlur(): void }>(input).onBlur());
}

test("profile loading and failure preserve editable local settings and Retry obtains the real profile", async () => {
  const first = deferred<AccountProfile>(),
    retry = deferred<AccountProfile>();
  const patches: Partial<Settings>[] = [];
  let reads = 0;
  await withDOM(
    async ({ document, render, click }) => {
      await render(
        createElement(
          AccountTab,
          props({
            save: async (patch) => {
              patches.push(patch);
              return true;
            },
          }),
        ),
      );
      assert.ok(
        document.querySelector(
          '[aria-label="Loading profile"][aria-busy="true"]',
        ),
      );
      assert.equal(
        document.querySelector('input[aria-label="Full name"]'),
        null,
      );
      assert.ok(document.querySelector('input[aria-label="Display name"]'));
      assert.ok(
        document.querySelector(
          'textarea[aria-label="Instructions for Claudex"]',
        ),
      );
      await editInput(document, "Display name", "Local changed");
      assert.deepEqual(patches, [{ name: "Local changed" }]);
      await act(async () => first.reject(new Error("offline")));
      assert.match(
        document.querySelector('[data-setting="Full name"] [role="alert"]')!
          .textContent!,
        /Couldn’t load your profile/,
      );
      assert.ok(document.querySelector('input[aria-label="Display name"]'));
      assert.equal(
        document.querySelector('input[aria-label="Full name"]'),
        null,
      );
      await click('[data-setting="Full name"] button');
      assert.equal(reads, 2);
      assert.ok(document.querySelector('[aria-label="Loading profile"]'));
      await act(async () => retry.resolve(profile));
      assert.equal(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Full name"]',
        )?.value,
        profile.fullName,
      );
      assert.ok(
        document.querySelector('[data-setting="Delete your account"] button'),
      );
    },
    { accountProfile: () => (++reads === 1 ? first.promise : retry.promise) },
  );
});

test("a missing service profile is a failed read, not a successful empty identity", async () => {
  await withDOM(
    async ({ document, render }) => {
      await render(createElement(AccountTab, props()));
      assert.ok(
        document.querySelector('[data-setting="Full name"] [role="alert"]'),
      );
      assert.equal(
        document.querySelector('input[aria-label="Full name"]'),
        null,
      );
      assert.ok(document.querySelector('input[aria-label="Display name"]'));
    },
    { accountProfile: async () => undefined as never },
  );
});

test("profile responses and captured Retry cannot cross an account/bridge owner", async () => {
  const first = deferred<AccountProfile>(),
    retry = deferred<AccountProfile>(),
    next = deferred<AccountProfile>();
  const errors: unknown[] = [];
  let oldReads = 0,
    nextReads = 0;
  const ref: { current: AppController | undefined } = { current: undefined };
  let app = {
    accountId: "A",
    controllerScope: {},
    currentController: ref,
  } as AppController;
  ref.current = app;
  await withDOM(
    async ({ document, render, click, replaceBridge }) => {
      const display = () =>
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(
            AccountTab,
            props({ onError: (error) => errors.push(error) }),
          ),
        );
      await render(display());
      await act(async () => first.reject(new Error("A offline")));
      const oldRetry = handlers<{ onClick(): void }>(
        document.querySelector('[data-setting="Full name"] button')!,
      ).onClick;
      await click('[data-setting="Full name"] button');
      assert.equal(oldReads, 2);
      app = { ...app, accountId: "B", controllerScope: {} };
      ref.current = app;
      replaceBridge({
        accountProfile: async () => {
          nextReads++;
          return next.promise;
        },
      });
      await render(display());
      await act(async () => {
        oldRetry();
        retry.resolve({ ...profile, fullName: "A private" });
      });
      assert.equal(oldReads, 2);
      assert.equal(nextReads, 1);
      assert.equal(
        document.querySelector('input[aria-label="Full name"]'),
        null,
      );
      assert.equal(errors.length, 1);
      await act(async () => next.resolve({ ...profile, fullName: "B real" }));
      assert.equal(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Full name"]',
        )?.value,
        "B real",
      );
      assert.doesNotMatch(
        document.querySelector("main")!.textContent!,
        /A private/,
      );
    },
    {
      accountProfile: () => (++oldReads === 1 ? first.promise : retry.promise),
    },
  );
});

test("Local devices loads the actual relay inventory and leaves unknown dates blank", async () => {
  const devices = deferred<DeviceInfo[]>();
  await withDOM(
    async ({ document, render }) => {
      await render(createElement(AccountTab, props()));
      assert.equal(
        document
          .querySelector(".account-local-devices tbody")
          ?.getAttribute("aria-busy"),
        "true",
      );
      assert.doesNotMatch(
        document.querySelector(".account-local-devices")!.textContent!,
        /No devices found/,
      );
      await act(async () =>
        devices.resolve([
          {
            id: "mac",
            name: "Real Mac",
            platform: "darwin",
            version: "1",
            connectedAt: "2026-10-19",
            addedAt: "2026-10-01",
            lastSeenAt: "2026-10-18",
          },
          {
            id: "pc",
            name: "Real PC",
            platform: "win32",
            version: "1",
            connectedAt: "2026-10-19",
          },
        ]),
      );
      const headers = Array.from(
        document.querySelectorAll(".account-local-devices th"),
        (e) => e.textContent,
      );
      assert.deepEqual(headers, ["Name", "OS", "Added", "Last seen", ""]);
      const rows = document.querySelectorAll(".account-local-devices tbody tr");
      assert.match(rows[0].textContent!, /Real MacmacOS/);
      assert.equal(rows[1].textContent, "Real PCWindows——");
      assert.ok(
        document.querySelector(
          'button[aria-label="Actions for Real Mac"][aria-haspopup="menu"]',
        ),
        "actual device details action without a removal protocol",
      );
      assert.doesNotMatch(
        document.querySelector("main")!.textContent!,
        /Organization ID|Require trusted devices/,
      );
    },
    { listCoworkDevices: () => devices.promise },
  );
});

test("Account exposes the supported Profile photo menu and rejects files above 10MB before cropping", async () => {
  const saves: unknown[] = [];
  await withDOM(async ({ document, render }) => {
    await render(
      createElement(
        AccountTab,
        props({
          settings: { ...defaultSettings, profilePhotoEnabled: false },
          save: async (patch) => {
            saves.push(patch);
            return true;
          },
        }),
      ),
    );
    assert.match(
      document.querySelector('[data-setting="Profile photo"]')!.textContent!,
      /PNG, JPEG, or WebP, up to 10MB/,
    );
    assert.ok(
      document.querySelector(
        'button[aria-label="Profile photo"][aria-haspopup="menu"]',
      ),
    );
    const input = document.querySelector(
      '.settings-avatar-group input[type="file"]',
    )!;
    const onChange = () =>
      handlers<{ onChange(event: unknown): void }>(input).onChange;
    await act(async () =>
      onChange()({
        target: {
          files: [
            new File([new Uint8Array(accountPhotoLimit + 1)], "large.png", {
              type: "image/png",
            }),
          ],
          value: "large.png",
        },
      }),
    );
    assert.equal(
      document.querySelector('[role="dialog"][aria-label="Crop photo"]'),
      null,
    );
    assert.deepEqual(saves, []);
    await act(async () =>
      onChange()({
        target: {
          files: [
            new File([new Uint8Array(accountPhotoLimit)], "limit.png", {
              type: "image/png",
            }),
          ],
          value: "limit.png",
        },
      }),
    );
    assert.ok(
      document.querySelector('[role="dialog"][aria-label="Crop photo"]'),
    );
    assert.deepEqual(saves, []);
  });
});

test("all 72 avatar radios use the observed shape/palette labels including swapped variants 33/34", async () => {
  await withDOM(async ({ document, render }) => {
    await render(
      createElement(AvatarDialogs, {
        current: 1,
        busy: false,
        onClose() {},
        onSave: async () => {},
      }),
    );
    const radios = document.querySelectorAll('[role="radio"]');
    assert.equal(radios.length, 72);
    assert.equal(
      new Set(Array.from(radios, (r) => r.getAttribute("aria-label"))).size,
      72,
    );
    const first = [
      "olive green on sage green",
      "blue on sage green",
      "lavender on pink",
      "beige on pink",
      "pink on lavender",
      "blue on lavender",
      "pink on beige",
      "olive green on beige",
      "sage green on olive green",
      "beige on olive green",
      "sage green on blue",
      "lavender on blue",
    ];
    assert.deepEqual(
      Array.from(radios)
        .slice(0, 12)
        .map((r) => r.getAttribute("aria-label")),
      first.map((p) => `Flower, ${p}`),
    );
    assert.equal(avatarLabel(13), "Grid, olive green on sage green");
    assert.equal(avatarLabel(33), "Hourglass, beige on olive green");
    assert.equal(avatarLabel(34), "Hourglass, sage green on olive green");
    assert.deepEqual(
      Array.from(radios, (r) => Number(r.getAttribute("data-variant"))),
      avatarVariants,
    );
    assert.ok(
      document.querySelector('[role="radio"] img[width="32"][height="32"]'),
    );
  });
});

function shortcut(form: Element, target: Element, patch = {}) {
  let prevented = false;
  handlers<{ onKeyDown(event: unknown): void }>(form).onKeyDown({
    key: "Enter",
    keyCode: 13,
    repeat: false,
    metaKey: true,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    currentTarget: form,
    target,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
    ...patch,
  });
  return prevented;
}

test("avatar submit shares unchanged/busy guards and ignores IME, repeats and nested dialogs", async () => {
  const pending = deferred<void>();
  const saves: number[] = [];
  let closes = 0;
  await withDOM(async ({ document, render, click }) => {
    await render(
      createElement(AvatarDialogs, {
        current: 1,
        busy: false,
        onClose() {
          closes++;
        },
        onSave: async (value) => {
          saves.push(value);
          return pending.promise;
        },
      }),
    );
    const form = document.querySelector("form.settings-avatar-picker")!;
    const first = document.querySelector('[role="radio"]')!;
    await act(async () => {
      shortcut(form, first);
    });
    assert.deepEqual(saves, []);
    await click('[data-variant="13"]');
    for (const patch of [
      { metaKey: false },
      { nativeEvent: { isComposing: true } },
      { keyCode: 229 },
      { repeat: true },
    ])
      await act(async () => {
        shortcut(form, first, patch);
      });
    assert.deepEqual(saves, []);
    const nested = document.createElement("div");
    nested.setAttribute("role", "dialog");
    document.body.appendChild(nested);
    await act(async () => {
      shortcut(form, nested);
    });
    nested.remove();
    assert.deepEqual(saves, []);
    await act(async () => {
      assert.ok(shortcut(form, first));
      shortcut(form, first, { metaKey: false, ctrlKey: true });
    });
    assert.deepEqual(saves, [13]);
    assert.ok(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".settings-avatar-dialog button",
        ),
      ).every((b) => b.disabled),
    );
    await click(".settings-avatar-dialog .settings-actions button:first-child");
    assert.equal(closes, 0);
    await act(async () => pending.resolve());
    assert.equal(
      document.querySelector<HTMLButtonElement>('[data-variant="13"]')
        ?.disabled,
      false,
    );
    await click(".settings-avatar-dialog .settings-actions button:first-child");
    assert.equal(closes, 1);
  });
});

test("Shuffle chooses a different avatar and announces its exact descriptive name", async () => {
  const random = Math.random;
  Math.random = () => 0;
  try {
    await withDOM(async ({ document, render, click }) => {
      await render(
        createElement(AvatarDialogs, {
          current: 1,
          busy: false,
          onClose() {},
          onSave: async () => {},
        }),
      );
      await click(".settings-avatar-footer > button");
      assert.equal(
        document
          .querySelector('[aria-checked="true"]')
          ?.getAttribute("data-variant"),
        "2",
      );
      assert.equal(
        document.querySelector('[role="status"]')?.textContent,
        "Selected Flower, blue on sage green",
      );
      await click('[data-variant="13"]');
      assert.equal(document.querySelector('[role="status"]')?.textContent, "");
    });
  } finally {
    Math.random = random;
  }
});

test("choosing the same variant can replace an existing photo", async () => {
  const saves: number[] = [];
  await withDOM(async ({ document, render, click }) => {
    await render(
      createElement(AvatarDialogs, {
        current: 1,
        hasPhoto: true,
        busy: false,
        onClose() {},
        onSave: async (value) => {
          saves.push(value);
        },
      }),
    );
    const save = document.querySelector<HTMLButtonElement>(
      ".settings-avatar-dialog .settings-actions button:last-child",
    )!;
    assert.equal(save.disabled, false);
    await click(".settings-avatar-dialog .settings-actions button:last-child");
    assert.deepEqual(saves, [1]);
  });
});

test("device failures remain distinct from empty inventory and Retry uses the actual bridge", async () => {
  const first = deferred<DeviceInfo[]>(),
    retry = deferred<DeviceInfo[]>();
  let reads = 0;
  await withDOM(
    async ({ document, render, click }) => {
      await render(createElement(AccountTab, props()));
      await act(async () => first.reject(new Error("device service offline")));
      assert.match(
        document.querySelector('.account-local-devices [role="alert"]')!
          .textContent!,
        /Couldn’t load your computers/,
      );
      assert.doesNotMatch(
        document.querySelector(".account-local-devices")!.textContent!,
        /No devices found/,
      );
      await click(".account-local-devices button");
      assert.equal(reads, 2);
      assert.equal(
        document
          .querySelector(".account-local-devices tbody")
          ?.getAttribute("aria-busy"),
        "true",
      );
      await act(async () => retry.resolve([]));
      assert.equal(
        document.querySelector('.account-local-devices [role="alert"]'),
        null,
      );
      assert.match(
        document.querySelector(".account-local-devices")!.textContent!,
        /No devices found/,
      );
    },
    {
      listCoworkDevices: () => (++reads === 1 ? first.promise : retry.promise),
    },
  );
});
