import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(
  new URL(
    "../../backend/backend/internal/claudex/sharing/viewer/templates/install.js",
    import.meta.url,
  ),
  "utf8",
);

async function browser(
  userAgent: string,
  promptApi = false,
  draw = true,
  options: { standalone?: boolean; title?: string } = {},
) {
  const handlers: Record<string, (event?: any) => any> = {};
  const timers: (() => void)[] = [];
  const head: any[] = [];
  const elements: Record<string, any> = {};
  const storage = new Map();
  const node = () => ({
    textContent: "",
    disabled: false,
    title: "",
    addEventListener(name: string, callback: any) {
      handlers[
        this === elements["[data-install-artifact]"] ? name : "dialog-" + name
      ] = callback;
    },
  });
  elements["[data-install-artifact]"] = node();
  elements["[data-install-messages]"] = { textContent: "{}" };
  elements["[data-install-reason]"] = node();
  elements[".bar-title"] = { textContent: options.title ?? "Chart" };
  const steps: Record<string, any> = {
    h2: node(),
    p: node(),
    button: node(),
    ol: {
      items: [],
      replaceChildren(...items: any[]) {
        this.items = items;
      },
    },
  };
  const dialog = {
    open: false,
    querySelector: (selector: string) => steps[selector],
    showModal() {
      this.open = true;
    },
  };
  elements["[data-install-steps]"] = dialog;
  const window: any = {
    addEventListener: (name: string, handler: any) => {
      handlers[name] = handler;
    },
  };
  if (promptApi) window.onbeforeinstallprompt = null;
  const context = vm.createContext({
    window,
    navigator: {
      userAgent,
      maxTouchPoints: 0,
      languages: ["en-US"],
      language: "en-US",
      standalone: options.standalone,
    },
    location: {
      origin: "https://claudex.test",
      pathname: "/prefix/s/TokenABC",
      search: options.standalone ? "?installed=1" : "",
    },
    URLSearchParams,
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: () => ({
      matches: Boolean(options.standalone),
      addEventListener() {},
    }),
    getComputedStyle: () => ({ backgroundColor: "rgb(255, 255, 255)" }),
    Image: class {
      onload?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
    setTimeout: (callback: () => void) => timers.push(callback),
    document: {
      querySelector: (selector: string) => elements[selector],
      head: { append: (value: any) => head.push(value) },
      createElement: (tag: string) =>
        tag === "canvas"
          ? {
              getContext: () =>
                draw
                  ? {
                      drawImage() {},
                      getImageData: () => ({ data: [242, 242, 241, 255] }),
                    }
                  : null,
              toDataURL: () => "data:image/png;base64,icon",
            }
          : node(),
    },
  });
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    button: elements["[data-install-artifact]"],
    handlers,
    head,
    timers,
    dialog,
    steps,
  };
}

test("published artifacts get a scoped standalone manifest, PNG icons and an installed start URL", async () => {
  const page = await browser("Chrome/130", true);
  const manifest = JSON.parse(
    decodeURIComponent(
      page.head
        .find((element) => element.rel === "manifest")
        .href.split(",")[1],
    ),
  );
  assert.equal(manifest.name, "Chart – Claudex artifact");
  assert.equal(
    manifest.start_url,
    "https://claudex.test/prefix/s/TokenABC?installed=1",
  );
  assert.equal(manifest.scope, "https://claudex.test/prefix/s/TokenABC");
  assert.equal(manifest.id, "https://claudex.test/artifact/tokenabc");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(
    manifest.icons.map((icon: any) => icon.sizes),
    ["192x192", "512x512"],
  );
  assert.ok(page.head.some((element) => element.rel === "apple-touch-icon"));
});

test("Safari on iOS and macOS shows the official browser steps; old Safari explains why not", async () => {
  const ios = await browser("iPhone Version/18.0 Mobile/123 Safari/604");
  assert.equal(ios.button.textContent, "Add to Home Screen");
  await ios.handlers.click();
  assert.equal(ios.dialog.open, true);
  assert.match(ios.steps.ol.items[0].textContent, /Tap Share in Safari/);
  assert.equal(ios.steps.ol.items[2].textContent, "Tap Add.");
  const mac = await browser("Macintosh Version/17.0 Safari/605");
  assert.equal(mac.button.textContent, "Add to Dock");
  await mac.handlers.click();
  assert.match(mac.steps.ol.items[0].textContent, /macOS Sonoma or later/);
  const old = await browser("Macintosh Version/16.0 Safari/605");
  assert.equal(old.button.disabled, true);
  assert.match(old.button.title, /Safari 17 or later/);
});

test("Chromium prompts only on a user click, remembers dismissal and reports failed icon generation", async () => {
  const page = await browser("Chrome/130", true);
  let prompts = 0;
  page.handlers.beforeinstallprompt({
    preventDefault() {},
    prompt: async () => {
      prompts++;
    },
    userChoice: Promise.resolve({ outcome: "dismissed" }),
  });
  assert.equal(prompts, 0);
  assert.equal(page.button.disabled, false);
  await page.handlers.click();
  assert.equal(prompts, 1);
  assert.equal(page.button.disabled, true);
  assert.match(page.button.title, /You closed the install dialog/);
  const failed = await browser("Chrome/130", true, false);
  assert.equal(failed.button.disabled, true);
  assert.match(failed.button.title, /couldn’t draw the artifact’s icon/);
});

test("installed windows are scoped to their artifact and titles use the official visibility and length rules", async () => {
  const installed = await browser("Chrome/130", true, true, {
    standalone: true,
  });
  assert.equal(installed.button.disabled, true);
  assert.equal(
    installed.button.title,
    "Already installed and open in its own window.",
  );
  const invisible = await browser("Chrome/130", true, true, {
    title: "\u2800\u0301\u200B",
  });
  const manifest = (page: Awaited<ReturnType<typeof browser>>) =>
    JSON.parse(
      decodeURIComponent(
        page.head
          .find((element) => element.rel === "manifest")
          .href.split(",")[1],
      ),
    );
  assert.equal(manifest(invisible).short_name, "Untitled artifact");
  const long = await browser("Chrome/130", true, true, {
    title: "🎨".repeat(61),
  });
  assert.equal(manifest(long).short_name, "🎨".repeat(59) + "…");
});
