import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialCloudEnvironment } from "../../shared/cloud-environments-api";
import {
  refreshCloudEnvironments,
  useCloudEnvironments,
} from "../../src/composer/cloud-environments";

function snapshot() {
  let state: ReturnType<typeof useCloudEnvironments> | undefined;
  function Probe() {
    state = useCloudEnvironments(() => {});
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return state!;
}

test("failed environment loads stay errors and never replace the last valid profiles", async () => {
  const priorWindow = globalThis.window;
  let response: unknown;
  let failure: Error | undefined;
  globalThis.window = {
    desktop: {
      listCloudEnvironments: async () => {
        if (failure) throw failure;
        return response;
      },
    },
  } as unknown as Window & typeof globalThis;
  try {
    assert.deepEqual(snapshot().environments, []);
    assert.equal(snapshot().loaded, false);
    await assert.rejects(
      refreshCloudEnvironments(),
      /Couldn’t load cloud environments/,
    );
    assert.deepEqual(snapshot().environments, []);
    assert.equal(snapshot().loaded, false);
    assert.ok(snapshot().error);

    response = [{ ...initialCloudEnvironment }];
    await refreshCloudEnvironments();
    assert.deepEqual(snapshot().environments, response);
    assert.equal(snapshot().selectedId, "default");
    assert.equal(snapshot().loaded, true);
    assert.equal(snapshot().error, undefined);

    for (const invalid of [
      null,
      {},
      [null],
      [{ id: "bad", name: "Bad", network: "full" }],
    ]) {
      response = invalid;
      await assert.rejects(
        refreshCloudEnvironments(),
        /Couldn’t load cloud environments/,
      );
      assert.deepEqual(snapshot().environments, [initialCloudEnvironment]);
      assert.ok(snapshot().error);
    }

    failure = new Error("Service is unavailable");
    await assert.rejects(refreshCloudEnvironments(), /Service is unavailable/);
    assert.deepEqual(snapshot().environments, [initialCloudEnvironment]);
    assert.equal(snapshot().error, failure);

    failure = undefined;
    response = [];
    await refreshCloudEnvironments();
    assert.deepEqual(snapshot().environments, []);
    assert.equal(snapshot().selectedId, "");
    assert.equal(snapshot().error, undefined);
  } finally {
    globalThis.window = priorWindow;
  }
});
