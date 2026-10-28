import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { act, createElement as h } from "react";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import {
  createModelCatalogStore,
  modelCatalogStore,
} from "../../src/composer/model-catalog-store";
import { useModelCatalog } from "../../src/composer/useComposerServices";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ModelMenu } from "../../src/composer/model/ModelMenu";
import { CodeModelMenu } from "../../src/composer/model/CodeModelMenu";
import { routineDom } from "../support/routine-dom";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const catalog = (id: string): ModelCatalog => ({
  defaultModel: id,
  items: [
    {
      id,
      displayName: id,
      description: "Actual catalog description",
      badges: [],
      sort: 0,
      hidden: false,
      isDefault: true,
      usageHint: "",
      efforts: ["low", "high"],
    },
  ],
});
function bridge() {
  const requests: {
    resolve(value: ModelCatalog | null): void;
    reject(error: Error): void;
  }[] = [];
  const events = new Set<(event: { type: string }) => void>();
  const value = {
    modelCatalog: () =>
      new Promise<ModelCatalog | null>((resolve, reject) =>
        requests.push({ resolve, reject }),
      ),
    onEvent: (listener: (event: { type: string }) => void) => {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
  } as unknown as Window["desktop"];
  return {
    value,
    requests,
    events,
    emit(type: string) {
      for (const listener of events) listener({ type });
    },
  };
}

async function menuDom(api: Window["desktop"]) {
  const env = await routineDom(api);
  env.window.innerWidth = 1440;
  env.window.innerHeight = 900;
  const mediaListeners = new Set<() => void>();
  env.window.matchMedia = (query: string) =>
    ({
      get matches() {
        const max = /max-width:\s*([\d.]+)px/.exec(query);
        return max ? env.window.innerWidth <= Number(max[1]) : false;
      },
      addEventListener(_type: string, listener: () => void) {
        mediaListeners.add(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        mediaListeners.delete(listener);
      },
    }) as unknown as MediaQueryList;
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "getComputedStyle",
  );
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ overflow: "visible", overflowX: "visible" }),
  });
  return {
    ...env,
    async width(value: number) {
      await act(async () => {
        env.window.innerWidth = value;
        for (const listener of [...mediaListeners]) listener();
      });
    },
    async clean() {
      await env.clean();
      if (previous)
        Object.defineProperty(globalThis, "getComputedStyle", previous);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
    },
  };
}

test("catalog pending, ready-null, read failure and retry remain distinct", async () => {
  const api = bridge(),
    store = createModelCatalogStore(api.value);
  assert.deepEqual(store.snapshot(), { status: "pending", value: undefined });
  const off = store.subscribe(() => {});
  try {
    await tick();
    api.requests[0].reject(new Error("synthetic backend read failure"));
    await tick();
    assert.deepEqual(store.snapshot(), { status: "error", value: undefined });
    store.retry();
    await tick();
    assert.deepEqual(store.snapshot(), { status: "pending", value: undefined });
    api.requests[1].resolve(null);
    await tick();
    assert.deepEqual(store.snapshot(), { status: "ready", value: null });
  } finally {
    off();
  }
});

test("real events preserve usable cache and superseded results cannot overwrite it", async () => {
  const api = bridge(),
    store = createModelCatalogStore(api.value);
  const off = store.subscribe(() => {});
  try {
    await tick();
    const previous = catalog("previous");
    api.requests[0].resolve(previous);
    await tick();
    for (const type of ["settings", "policy", "service-changed"])
      api.emit(type);
    api.emit("conversation");
    await tick();
    assert.equal(api.requests.length, 4);
    assert.deepEqual(store.snapshot(), { status: "pending", value: previous });
    api.requests[3].resolve(catalog("current"));
    api.requests[1].resolve(catalog("stale"));
    api.requests[2].reject(new Error("stale failure"));
    await tick();
    assert.equal(store.snapshot().value?.defaultModel, "current");
    store.retry();
    await tick();
    api.requests[4].reject(new Error("refresh failed"));
    await tick();
    assert.equal(store.snapshot().status, "error");
    assert.equal(store.snapshot().value?.defaultModel, "current");
  } finally {
    off();
  }
});

test("detached reads cannot populate cache and a remount starts a fresh generation", async () => {
  const api = bridge(),
    store = createModelCatalogStore(api.value);
  const off = store.subscribe(() => {});
  await tick();
  off();
  assert.equal(api.events.size, 0);
  api.requests[0].resolve(catalog("detached"));
  await tick();
  assert.equal(store.snapshot().value, undefined);
  const close = store.subscribe(() => {});
  try {
    await tick();
    api.requests[1].resolve(catalog("remounted"));
    await tick();
    assert.equal(store.snapshot().value?.defaultModel, "remounted");
  } finally {
    close();
  }
});

test("catalog stores are isolated by actual account and bridge identities", async () => {
  const first = bridge(),
    second = bridge();
  const a = modelCatalogStore(first.value, "account-a"),
    b = modelCatalogStore(first.value, "account-b"),
    otherBridge = modelCatalogStore(second.value, "account-a");
  assert.equal(a, modelCatalogStore(first.value, "account-a"));
  assert.notEqual(a, b);
  assert.notEqual(a, otherBridge);
  const off = [a, b, otherBridge].map((store) => store.subscribe(() => {}));
  try {
    await tick();
    first.requests[0].resolve(catalog("only-a"));
    first.requests[1].resolve(null);
    second.requests[0].resolve(catalog("other-bridge"));
    await tick();
    assert.equal(a.snapshot().value?.defaultModel, "only-a");
    assert.equal(b.snapshot().value, null);
    assert.equal(otherBridge.snapshot().value?.defaultModel, "other-bridge");
  } finally {
    off.forEach((close) => close());
  }
});

const provider = {
  id: "configured",
  name: "Configured provider",
  baseUrl: "http://127.0.0.1:1",
  protocol: "responses" as const,
  model: "configured-model",
  models: ["configured-model"],
};
const menuProps = {
  providers: [provider],
  providerId: provider.id,
  model: provider.model,
  effort: "high" as const,
  onSelect() {},
  onEffort() {},
  onManage() {},
  onClose() {},
};

test("real ModelMenu never substitutes provider/effort rows for an unresolved or failed catalog", async () => {
  const api = bridge(),
    env = await menuDom(api.value);
  // routineDom merges into its bridge; use this actual object as the scope.
  env.window.innerWidth = 1440;
  env.window.innerHeight = 900;
  try {
    await env.render(h(ModelMenu, menuProps));
    assert.equal(
      env.document.querySelector('[role="status"]')?.getAttribute("aria-label"),
      "Select model",
    );
    assert.equal(
      env.document.querySelector('[role="status"]')?.textContent,
      "",
    );
    assert.equal(
      env.document.querySelector(".model-menu")?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(env.document.querySelector('[role="menuitemradio"]'), null);
    assert.equal(env.document.querySelector('[data-branch="effort"]'), null);
    await act(async () => {
      api.requests[0].reject(new Error("raw transport secret"));
    });
    assert.match(
      env.document.querySelector('[role="status"]')?.textContent ?? "",
      /Couldn’t load this\./,
    );
    assert.doesNotMatch(
      env.document.body.textContent!,
      /raw transport secret|configured-model/,
    );
    await env.click(".chunk-error button");
    assert.equal(env.document.querySelector('[role="menuitemradio"]'), null);
    await act(async () => {
      api.requests[1].resolve(null);
    });
    assert.match(
      env.document.querySelector(".model-menu-current")?.textContent ?? "",
      /configured-model/,
    );
    assert.ok(env.document.querySelector('[data-branch="effort"]'));
    assert.equal(env.document.querySelector(".chunk-error"), null);
  } finally {
    await env.clean();
  }
});

test("account replacement drops old menu rows synchronously and ignores its late read", async () => {
  const api = bridge(),
    env = await menuDom(api.value);
  env.window.innerWidth = 1440;
  env.window.innerHeight = 900;
  const render = (accountId: string) =>
    env.render(
      h(
        AppContext.Provider,
        { value: { accountId } as AppController },
        h(ModelMenu, menuProps),
      ),
    );
  try {
    await render("first-account");
    await render("second-account");
    await act(async () => {
      api.requests[0].resolve(catalog("first-private"));
    });
    assert.doesNotMatch(
      env.document.body.textContent!,
      /first-private|configured-model/,
    );
    await act(async () => {
      api.requests[1].resolve(catalog("second-model"));
    });
    assert.equal(
      env.document.querySelector(".model-menu")?.getAttribute("aria-busy"),
      null,
    );
    await render("first-account");
    assert.doesNotMatch(
      env.document.body.textContent!,
      /second-model|first-private/,
    );
    assert.equal(
      env.document.querySelector('[role="status"]')?.getAttribute("aria-label"),
      "Select model",
    );
    assert.equal(
      env.document.querySelector('[role="status"]')?.textContent,
      "",
    );
  } finally {
    await env.clean();
  }
});

test("legacy value-only callers and Code retain their real configured fallback", async () => {
  const api = bridge(),
    env = await menuDom(api.value);
  function Value() {
    return h("output", null, useModelCatalog()?.defaultModel ?? "legacy-null");
  }
  try {
    await env.render(h(Value));
    assert.equal(
      env.document.querySelector("output")?.textContent,
      "legacy-null",
    );
    await act(async () => {
      api.requests[0].resolve(null);
    });
    assert.equal(
      env.document.querySelector("output")?.textContent,
      "legacy-null",
    );
    await env.render(h(CodeModelMenu, menuProps));
    assert.match(env.document.body.textContent!, /configured-model/);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /Loading models|Couldn’t load/,
    );
    assert.equal(env.document.querySelector(".chunk-error"), null);
  } finally {
    await env.clean();
  }
});

test("a mounted menu retains real cached rows through refresh failure and retries the same service", async () => {
  const api = bridge(),
    env = await menuDom(api.value);
  const actual = catalog(provider.model);
  actual.items[0].displayName = "Actual configured model";
  try {
    await env.render(h(ModelMenu, menuProps));
    await act(async () => {
      api.requests[0].resolve(actual);
    });
    assert.match(
      env.document.querySelector(".model-menu-current")?.textContent ?? "",
      /Actual configured model/,
    );
    await act(async () => {
      api.emit("service-changed");
    });
    assert.equal(
      env.document.querySelector(".model-menu")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(
      env.document.querySelector(".model-menu-current")?.textContent ?? "",
      /Actual configured model/,
    );
    await act(async () => {
      api.requests[1].reject(new Error("refresh failed"));
    });
    assert.ok(env.document.querySelector(".chunk-error button"));
    assert.match(
      env.document.querySelector(".model-menu-current")?.textContent ?? "",
      /Actual configured model/,
    );
    await env.click(".chunk-error button");
    await act(async () => {
      api.requests[2].resolve(actual);
    });
    assert.equal(env.document.querySelector(".chunk-error"), null);
    assert.equal(
      env.document.querySelector(".model-menu")?.getAttribute("aria-busy"),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("replacing the mounted bridge drops previous rows and prevents late cross-bridge publication", async () => {
  const first = bridge(),
    second = bridge(),
    env = await menuDom(first.value);
  const initialBridge = env.window.desktop;
  try {
    await env.render(h(ModelMenu, menuProps));
    env.window.desktop = second.value;
    await env.render(h(ModelMenu, menuProps));
    await act(async () => {
      first.requests[0].resolve(catalog("old-bridge-model"));
    });
    assert.equal(env.document.querySelector('[role="menuitemradio"]'), null);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /old-bridge-model|configured-model/,
    );
    await act(async () => {
      second.requests[0].resolve(null);
    });
    assert.match(
      env.document.querySelector(".model-menu-current")?.textContent ?? "",
      /configured-model/,
    );
    assert.equal(
      modelCatalogStore(initialBridge, "").snapshot().value,
      undefined,
    );
  } finally {
    await env.clean();
  }
});

test("inline scroll shell and header rules use current measured geometry without fixed inventory height", () => {
  const sheet = postcss.parse(
    readFileSync(
      new URL("../../src/composer/model/model-menu.css", import.meta.url),
      "utf8",
    ),
  );
  const declarations = (selector: string) => {
    const result: Record<string, string> = {};
    sheet.walkRules(selector, (rule) => {
      rule.walkDecls((decl) => {
        result[decl.prop] = decl.value;
      });
    });
    return result;
  };
  const popup = declarations(".model-menu.model-menu-inline");
  assert.equal(declarations(".model-menu").bottom, "calc(100% + 4px)");
  assert.equal(
    popup["max-height"],
    "var(--model-menu-available-height, calc(100dvh - 36px))",
  );
  assert.equal(popup["max-width"], "calc(100vw - 12px)");
  assert.equal(popup.overflow, "visible");
  assert.equal(popup.height, undefined);
  const body = declarations(".model-menu-inline-body");
  assert.equal(body.overflow, "hidden auto");
  assert.equal(body.padding, "4px");
  assert.equal(body["min-height"], "0");
  assert.equal(body["border-bottom"], "1px solid transparent");
  const label = declarations(".model-menu-inline .model-menu-group-label");
  assert.equal(label["font-size"], "13px");
  assert.equal(label["line-height"], "17px");
  assert.equal(label["font-weight"], "400");
  assert.equal(label.padding, "4px 10px");
  const row = declarations(".model-menu-inline .model-inline-group > button");
  assert.equal(row.height, "32px");
  assert.equal(17 + 2 * 4 + 5 * Number.parseFloat(row.height), 185);
  assert.equal(17 + 2 * 4 + 12 * Number.parseFloat(row.height), 409);
});

test("a pending home popup stays above its trigger when the settled catalog grows", async () => {
  const api = bridge(),
    env = await menuDom(api.value);
  const prototype = env.window.HTMLElement.prototype;
  const previous = Object.getOwnPropertyDescriptor(
    prototype,
    "getBoundingClientRect",
  );
  prototype.getBoundingClientRect = function () {
    const height = this.querySelector('[role="menuitemradio"]') ? 500 : 32;
    const top = this.classList.contains("opens-up") ? 800 - height : 820;
    return {
      x: 100,
      y: top,
      top,
      left: 100,
      right: 394.5,
      bottom: top + height,
      width: 294.5,
      height,
      toJSON() {},
    };
  };
  env.window.innerHeight = 844;
  try {
    await env.render(
      h(
        "div",
        { className: "chat-home" },
        h("div", { className: "model-effort-anchor" }, h(ModelMenu, menuProps)),
      ),
    );
    assert.ok(env.document.querySelector(".model-menu.opens-up"));
    await act(async () => {
      api.requests[0].resolve(catalog(provider.model));
    });
    assert.ok(
      env.document.querySelector(".model-menu.opens-up"),
      "measure the natural below-trigger position, not the already-flipped fitting rect",
    );
  } finally {
    await env.clean();
    if (previous)
      Object.defineProperty(prototype, "getBoundingClientRect", previous);
    else Reflect.deleteProperty(prototype, "getBoundingClientRect");
  }
});

test("a phone catalog fits the anchor's available height without focus scrolling the home page", async () => {
  const api = bridge(),
    env = await menuDom(api.value);
  env.window.innerWidth = 390;
  env.window.innerHeight = 844;
  const prototype = env.window.HTMLElement.prototype;
  const oldRect = Object.getOwnPropertyDescriptor(
    prototype,
    "getBoundingClientRect",
  );
  const oldFocus = prototype.focus;
  const focusCalls: { target: HTMLElement; options?: FocusOptions }[] = [];
  prototype.focus = function (options?: FocusOptions) {
    focusCalls.push({ target: this, options });
    oldFocus.call(this, options);
  };
  prototype.getBoundingClientRect = function () {
    const anchor = this.classList.contains("model-effort-anchor");
    const top = anchor ? 812 : this.classList.contains("opens-up") ? 0 : 841.5;
    const height = anchor
      ? 24
      : this.querySelector('[role="menuitemradio"]')
        ? 808
        : 32;
    return {
      x: 43,
      y: top,
      top,
      left: 43,
      right: 337.5,
      bottom: top + height,
      width: 294.5,
      height,
      toJSON() {},
    };
  };
  try {
    await env.render(
      h(
        "div",
        { className: "chat-home" },
        h("div", { className: "model-effort-anchor" }, h(ModelMenu, menuProps)),
      ),
    );
    const menu = env.document.querySelector<HTMLElement>(".model-menu")!;
    assert.ok(menu.classList.contains("opens-up"));
    assert.equal(
      menu.style.getPropertyValue("--model-menu-available-height"),
      "808px",
    );
    await act(async () => api.requests[0].resolve(catalog(provider.model)));
    assert.ok(
      menu.classList.contains("opens-up"),
      "long rows must not flip below the bottom-edge trigger",
    );
    assert.equal(
      menu.style.getPropertyValue("--model-menu-available-height"),
      "808px",
    );
    assert.ok(focusCalls.length > 0);
    assert.ok(
      focusCalls
        .filter((c) => c.target === menu)
        .every((c) => c.options?.preventScroll === true),
    );
  } finally {
    await env.clean();
    prototype.focus = oldFocus;
    if (oldRect)
      Object.defineProperty(prototype, "getBoundingClientRect", oldRect);
    else Reflect.deleteProperty(prototype, "getBoundingClientRect");
  }
});
