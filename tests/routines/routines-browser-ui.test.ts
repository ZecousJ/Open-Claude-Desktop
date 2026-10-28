import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import { RoutineBrowserPermissions } from "../../src/collections/routines/RoutineBrowserPermissions";
import { AppContext } from "../../src/app/AppContext";
import type { Routine } from "../../shared/routines";
const routine = { id: "r1", updatedAt: 1, mode: "code" } as Routine;
const grant = {
  mode: "domains",
  domains: ["https://example.com", "https://second.test"],
  approvedAt: 1,
} as const;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
test("mounted inventory uses real domains; failed revoke preserves them and Retry reads actual backend", async () => {
  let reads = 0;
  let writes = 0;
  const dom = await routineDom({
    routineBrowserPermissions: async () => {
      reads++;
      return { status: "supported", readOnly: false, grant: grant as any };
    },
    clearRoutineBrowserPermissions: async () => {
      if (++writes === 1) throw new Error("Disk unavailable");
    },
  });
  try {
    await dom.render(h(RoutineBrowserPermissions, { routine }));
    assert.match(
      dom.document.body.textContent!,
      /https:\/\/example.com, https:\/\/second.test/,
    );
    await dom.click('[aria-label="Remove approval"]');
    assert.match(dom.document.body.textContent!, /Disk unavailable/);
    assert.match(dom.document.body.textContent!, /second.test/);
    const retry = [...dom.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await dom.event(retry, "click");
    assert.equal(reads, 2);
    await dom.click('[aria-label="Remove approval"]');
    assert.equal(writes, 2);
    assert.doesNotMatch(dom.document.body.textContent!, /second.test/);
    assert.match(dom.document.body.textContent!, /Approvals you grant/);
  } finally {
    await dom.clean();
  }
});
for (const readOnly of ["backend", "view"] as const)
  test(`mounted ${readOnly} read-only Browser inventory has no revoke action`, async () => {
    let writes = 0;
    const dom = await routineDom({
      routineBrowserPermissions: async () => ({
        status: "supported",
        readOnly: readOnly === "backend",
        grant: { mode: "all-websites", approvedAt: 1 },
      }),
      clearRoutineBrowserPermissions: async () => {
        writes++;
      },
    });
    try {
      await dom.render(
        h(RoutineBrowserPermissions, {
          routine,
          readOnly: readOnly === "view",
        }),
      );
      assert.match(dom.document.body.textContent!, /All websites/);
      assert.equal(
        dom.document.querySelector('[aria-label="Remove approval"]'),
        null,
      );
      assert.equal(writes, 0);
    } finally {
      await dom.clean();
    }
  });
test("mounted pending, malformed/error/retry, and unsupported states never imply empty ready grants", async () => {
  const pending = deferred<any>();
  let reads = 0;
  const dom = await routineDom({
    routineBrowserPermissions: async () => {
      if (++reads === 1) return pending.promise;
      return {
        status: "unsupported",
        message: "No built-in Browser on this host",
      };
    },
  });
  try {
    await dom.render(h(RoutineBrowserPermissions, { routine }));
    assert.match(dom.document.body.textContent!, /Loading/);
    assert.doesNotMatch(dom.document.body.textContent!, /Approvals you grant/);
    await act(async () => pending.resolve({ status: "supported" }));
    assert.match(dom.document.body.textContent!, /invalid approval list/);
    assert.doesNotMatch(dom.document.body.textContent!, /Approvals you grant/);
    await dom.event(dom.document.querySelector("button")!, "click");
    assert.match(dom.document.body.textContent!, /No built-in Browser/);
    assert.equal(
      dom.document.querySelector('[aria-label="Remove approval"]'),
      null,
    );
  } finally {
    await dom.clean();
  }
});
test("mounted account/controller retirement drops old reads and revoke outcomes", async () => {
  const old = deferred<any>();
  const writes = deferred<void>();
  let accountId = "a";
  const dom = await routineDom({
    routineBrowserPermissions: async () =>
      accountId === "a"
        ? old.promise
        : { status: "supported", readOnly: false, grant: grant as any },
    clearRoutineBrowserPermissions: async () => writes.promise,
  });
  const controller = {
    current: { accountId, controllerScope: {}, page: "routines" },
  };
  const render = () =>
    dom.render(
      h(
        AppContext.Provider,
        {
          value: {
            accountId,
            controllerScope: controller.current.controllerScope,
            currentController: controller,
          } as any,
        },
        h(RoutineBrowserPermissions, { routine }),
      ),
    );
  try {
    await render();
    accountId = "b";
    controller.current = { accountId, controllerScope: {}, page: "routines" };
    await render();
    assert.match(dom.document.body.textContent!, /second.test/);
    await act(async () =>
      old.resolve({
        status: "supported",
        readOnly: false,
        grant: { mode: "all-websites", approvedAt: 1 },
      }),
    );
    assert.doesNotMatch(dom.document.body.textContent!, /All websites/);
    await dom.click('[aria-label="Remove approval"]');
    accountId = "c";
    controller.current = { accountId, controllerScope: {}, page: "routines" };
    await render();
    await act(async () => writes.resolve());
    assert.match(dom.document.body.textContent!, /second.test/);
  } finally {
    await dom.clean();
  }
});
