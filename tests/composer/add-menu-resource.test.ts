import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type {
  CustomizeSkill,
  DesignSystem,
} from "../../shared/collections-api";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import { useAddMenuResource } from "../../src/composer/useAddMenuResource";
import { routineDom } from "../support/routine-dom";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const skill = (name: string): CustomizeSkill => ({
  name,
  description: name,
  path: `/synthetic/${name}/SKILL.md`,
  scope: "user",
  enabled: true,
  own: true,
});
const design = (name: string): DesignSystem => ({
  id: name,
  name,
  blurb: "",
  notes: "",
  sources: [],
  guidelines: "Synthetic guidelines",
  createdAt: 1,
  updatedAt: 1,
});

async function environment(api: Partial<Window["desktop"]> = {}) {
  const env = await routineDom({
    customizeSkills: async () => [],
    listDesignSystems: async () => [],
    send: () => assert.fail("a resource read must not send a message"),
    setSkillEnabled: () =>
      assert.fail("a resource read must not enable a skill"),
    ...api,
  });
  env.window.innerWidth = 1440;
  env.window.innerHeight = 900;
  const descriptors = new Map(
    ["getComputedStyle", "HTMLElement"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ overflow: "visible", overflowX: "visible" }),
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: env.window.HTMLElement,
  });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, previous] of descriptors)
        if (previous) Object.defineProperty(globalThis, key, previous);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

function menu(accountId = "same-account") {
  return h(
    AppContext.Provider,
    { value: { accountId, snapshot: { settings: {} } } as AppController },
    h(ComposerAddMenu, {
      presentation: "web-chat",
      platform: "darwin",
      projects: [],
      webSearch: false,
      webSearchAvailable: false,
      onWebSearch() {},
      onClose() {},
      onFiles() {},
      onSkill: () => assert.fail("a resource read must not invoke a skill"),
      onProject() {},
      onCreateProject() {},
      onSettings() {},
      onUnavailable() {},
    }),
  );
}

for (const kind of ["skills", "design"] as const) {
  test(`${kind}: a same-account bridge replacement reads the new source and rejects the old late response`, async () => {
    const old = deferred<CustomizeSkill[] & DesignSystem[]>(),
      next = deferred<CustomizeSkill[] & DesignSystem[]>();
    let oldReads = 0,
      newReads = 0;
    const method = kind === "skills" ? "customizeSkills" : "listDesignSystems";
    const env = await environment({
      [method]: () => {
        oldReads++;
        return old.promise;
      },
    });
    try {
      await env.render(menu());
      await env.click(`[data-add-branch="${kind}"]`);
      assert.equal(oldReads, 1);
      assert.equal(
        env.document
          .querySelector(`[data-add-panel="${kind}"]`)
          ?.getAttribute("data-add-state"),
        "pending",
      );
      env.window.desktop = {
        customizeSkills: async () => [],
        listDesignSystems: async () => [],
        [method]: () => {
          newReads++;
          return next.promise;
        },
      } as never;
      await env.render(menu());
      assert.equal(
        newReads,
        1,
        "the same account must still read its replacement bridge",
      );
      await act(async () => {
        old.resolve([
          kind === "skills"
            ? skill("old-bridge-row")
            : design("old-bridge-row"),
        ] as never);
      });
      assert.equal(
        env.document
          .querySelector(`[data-add-panel="${kind}"]`)
          ?.getAttribute("data-add-state"),
        "pending",
      );
      assert.doesNotMatch(env.document.body.textContent!, /old-bridge-row/);
      await act(async () => {
        next.resolve([
          kind === "skills"
            ? skill("current-bridge-row")
            : design("current-bridge-row"),
        ] as never);
      });
      assert.match(
        env.document.querySelector(`[data-add-panel="${kind}"]`)!.textContent!,
        /current-bridge-row/,
      );
      assert.doesNotMatch(env.document.body.textContent!, /old-bridge-row/);
      assert.equal(newReads, 1);
    } finally {
      await env.clean();
    }
  });

  test(`${kind}: loaded rows disappear while its replacement source is unresolved`, async () => {
    const pending = deferred<never[]>();
    const method = kind === "skills" ? "customizeSkills" : "listDesignSystems";
    const env = await environment({
      [method]: async () => [
        kind === "skills" ? skill("old-loaded") : design("old-loaded"),
      ],
    });
    try {
      await env.render(menu());
      await env.click(`[data-add-branch="${kind}"]`);
      assert.match(env.document.body.textContent!, /old-loaded/);
      env.window.desktop = {
        customizeSkills: async () => [],
        listDesignSystems: async () => [],
        [method]: () => pending.promise,
      } as never;
      await env.render(menu());
      assert.equal(
        env.document
          .querySelector(`[data-add-panel="${kind}"]`)
          ?.getAttribute("data-add-state"),
        "pending",
      );
      assert.doesNotMatch(env.document.body.textContent!, /old-loaded/);
      await act(async () => {
        pending.resolve([]);
      });
      assert.equal(
        env.document
          .querySelector(`[data-add-panel="${kind}"]`)
          ?.getAttribute("data-add-state"),
        "empty",
      );
    } finally {
      await env.clean();
    }
  });
}

test("hook hides an old account/read error during render before the replacement effect", async () => {
  const pending = deferred<string[]>();
  const readOld = async () => {
    throw Error("old-read-error");
  };
  const readNew = () => pending.promise;
  const renders: { status: string; rows: string[] }[] = [];
  function Probe({
    account,
    read,
  }: {
    account: string;
    read: () => Promise<string[]>;
  }) {
    const value = useAddMenuResource(read, account);
    renders.push({
      status: value.status,
      rows: [...value.rows],
    });
    return h("output", null, value.status);
  }
  const env = await environment();
  try {
    await env.render(h(Probe, { account: "old", read: readOld }));
    assert.equal(renders.at(-1)?.status, "failed");
    renders.length = 0;
    await env.render(h(Probe, { account: "new", read: readNew }));
    assert.deepEqual(renders[0], {
      status: "pending",
      rows: [],
    });
    await act(async () => {
      pending.resolve(["new-read-row"]);
    });
    assert.deepEqual(renders.at(-1)?.rows, ["new-read-row"]);
  } finally {
    await env.clean();
  }
});

test("the first render with a replacement bridge hides already loaded rows before its effect", async () => {
  const old = deferred<CustomizeSkill[]>(),
    next = deferred<CustomizeSkill[]>();
  const env = await environment({ customizeSkills: () => old.promise });
  const states: { status: string; rows: string[] }[] = [];
  const read = (bridge: Window["desktop"]) =>
    bridge.customizeSkills().then((rows) => rows.map((row) => row.name));
  function Probe() {
    const value = useAddMenuResource(read, "same-account");
    states.push({
      status: value.status,
      rows: [...value.rows],
    });
    return h("output", null, value.rows.join(","));
  }
  try {
    await env.render(h(Probe));
    await act(async () => {
      old.resolve([skill("loaded-from-old-bridge")]);
    });
    assert.deepEqual(states.at(-1)?.rows, ["loaded-from-old-bridge"]);
    env.window.desktop = { customizeSkills: () => next.promise } as never;
    states.length = 0;
    await env.render(h(Probe));
    assert.deepEqual(states[0], {
      status: "pending",
      rows: [],
    });
    await act(async () => {
      next.resolve([skill("loaded-from-new-bridge")]);
    });
    assert.deepEqual(states.at(-1)?.rows, ["loaded-from-new-bridge"]);
  } finally {
    await env.clean();
  }
});

test("retained reload and A → B → A late reads cannot invalidate the current bridge generation", async () => {
  const requestsA: ReturnType<typeof deferred<string[]>>[] = [],
    requestsB: ReturnType<typeof deferred<string[]>>[] = [];
  const bridgeA = { id: "a" } as unknown as Window["desktop"],
    bridgeB = { id: "b" } as unknown as Window["desktop"];
  const captured: Window["desktop"][] = [];
  const read = (bridge: Window["desktop"]) => {
    captured.push(bridge);
    const request = deferred<string[]>();
    (bridge === bridgeA ? requestsA : requestsB).push(request);
    return request.promise;
  };
  let latest!: ReturnType<typeof useAddMenuResource<string>>;
  function Probe() {
    latest = useAddMenuResource(read, "same");
    return h("output", null, latest.rows.join(","));
  }
  const env = await environment();
  try {
    env.window.desktop = bridgeA;
    await env.render(h(Probe));
    const staleReload = latest.reload;
    env.window.desktop = bridgeB;
    await env.render(h(Probe));
    await act(async () => {
      staleReload();
    });
    assert.deepEqual(captured, [bridgeA, bridgeB]);
    env.window.desktop = bridgeA;
    await env.render(h(Probe));
    await act(async () => {
      requestsB[0].reject(Error("late-b-error"));
      requestsA[0].resolve(["old-a"]);
    });
    assert.equal(latest.status, "pending");
    assert.deepEqual(latest.rows, []);
    await act(async () => {
      requestsA[1].resolve(["new-a"]);
    });
    assert.equal(latest.status, "loaded");
    assert.deepEqual(latest.rows, ["new-a"]);
  } finally {
    await env.clean();
  }
});

test("same-source retries reject superseded responses and a detached read cannot render rows", async () => {
  const requests: ReturnType<typeof deferred<string[]>>[] = [];
  const read = () => {
    const request = deferred<string[]>();
    requests.push(request);
    return request.promise;
  };
  let latest!: ReturnType<typeof useAddMenuResource<string>>;
  const renders: string[][] = [];
  function Probe() {
    latest = useAddMenuResource(read, "same");
    renders.push([...latest.rows]);
    return h("output", null, latest.rows.join(","));
  }
  const env = await environment();
  try {
    await env.render(h(Probe));
    await act(async () => {
      latest.reload();
    });
    await act(async () => {
      requests[1].resolve(["latest"]);
      requests[0].reject(Error("stale-error"));
    });
    assert.equal(latest.status, "loaded");
    assert.deepEqual(latest.rows, ["latest"]);
    await act(async () => {
      latest.reload();
    });
    await env.render(h("p", null, "Other page"));
    const before = renders.length;
    await act(async () => {
      requests[2].resolve(["detached"]);
    });
    assert.equal(renders.length, before);
    assert.equal(env.document.querySelector("output"), null);
  } finally {
    await env.clean();
  }
});
