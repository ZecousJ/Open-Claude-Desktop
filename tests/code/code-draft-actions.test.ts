import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { WebCodeDraftActions } from "../../src/code-home/WebCodeDraftActions";
import type { DictationPhase } from "../../src/composer/voice/DictationButton";

test("an empty web Code draft has no Send, and every non-idle dictation phase keeps the microphone", () => {
  const render = (
    hasDraft: boolean,
    dictationPhase: DictationPhase,
    live = false,
  ) =>
    renderToStaticMarkup(
      createElement(WebCodeDraftActions, {
        hasDraft,
        dictationPhase,
        live,
        microphone: createElement(
          "button",
          { "data-microphone": true },
          "Microphone",
        ),
        submit: createElement("button", { "data-send": true }, "Send"),
      }),
    );
  assert.match(render(false, "idle"), /data-microphone/);
  assert.doesNotMatch(render(false, "idle"), /data-send/);
  for (const phase of ["requesting", "recording", "finishing"] as const) {
    assert.match(render(true, phase), /data-microphone/);
    assert.doesNotMatch(render(true, phase), /data-send/);
  }
  assert.match(render(true, "idle", true), /data-microphone/);
  assert.match(render(true, "idle"), /data-send/);
  assert.doesNotMatch(render(true, "idle"), /data-microphone/);
});

test("typing while microphone permission is pending does not unmount the live recorder", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let mounted = 0,
    unmounted = 0;
  function Recorder() {
    useEffect(() => {
      mounted++;
      return () => {
        unmounted++;
      };
    }, []);
    return createElement("button", { "data-recorder": true }, "Microphone");
  }
  const render = (hasDraft: boolean, phase: DictationPhase, live = false) =>
    act(async () => {
      root.render(
        createElement(WebCodeDraftActions, {
          hasDraft,
          dictationPhase: phase,
          live,
          microphone: createElement(Recorder),
          submit: createElement("button", { "data-send": true }, "Send"),
        }),
      );
    });
  try {
    await render(false, "idle");
    const recorder = document.querySelector("[data-recorder]");
    await render(false, "requesting");
    await render(true, "requesting");
    await render(true, "recording");
    await render(true, "finishing");
    await render(true, "idle", true);
    assert.equal(document.querySelector("[data-recorder]"), recorder);
    assert.deepEqual({ mounted, unmounted }, { mounted: 1, unmounted: 0 });
    assert.equal(document.querySelector("[data-send]"), null);
    await render(true, "idle");
    assert.deepEqual({ mounted, unmounted }, { mounted: 1, unmounted: 1 });
    assert.ok(document.querySelector("[data-send]"));
    await render(false, "idle");
    assert.deepEqual({ mounted, unmounted }, { mounted: 2, unmounted: 1 });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
