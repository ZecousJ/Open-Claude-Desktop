import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useRef } from "react";
import { useUploadQueue } from "../../src/composer/useUploadQueue";
import { routineDom } from "../support/routine-dom";

type Options = { later?: boolean };
const sent: (Options | undefined)[] = [];
let api!: ReturnType<typeof useUploadQueue<Options>>;
function Probe({ pending, draft }: { pending: number; draft: string }) {
  const submit = useRef<(options?: Options) => void>(undefined);
  submit.current = (options) => void sent.push(options);
  api = useUploadQueue<Options>(pending, draft, submit);
  return h("output", null, String(api.queued));
}

test("a send pressed during an upload waits, then goes out once the files are in", async () => {
  sent.length = 0;
  const env = await routineDom();
  try {
    await env.render(h(Probe, { pending: 1, draft: "a" }));
    await act(async () => api.wait({ later: true }));
    assert.ok(api.queued);
    assert.deepEqual(sent, []);
    await env.render(h(Probe, { pending: 1, draft: "a" }));
    assert.deepEqual(sent, []);
    await env.render(h(Probe, { pending: 0, draft: "a" }));
    assert.deepEqual(sent, [{ later: true }]);
    assert.ok(!api.queued);
  } finally {
    await env.clean();
  }
});

test("another draft or a failed file drops the wait", async () => {
  sent.length = 0;
  const env = await routineDom();
  try {
    await env.render(h(Probe, { pending: 1, draft: "a" }));
    await act(async () => api.wait());
    await env.render(h(Probe, { pending: 1, draft: "b" }));
    assert.ok(!api.queued);
    await env.render(h(Probe, { pending: 0, draft: "b" }));
    assert.deepEqual(sent, []);
    await env.render(h(Probe, { pending: 1, draft: "b" }));
    await act(async () => api.wait());
    await act(async () => api.cancel());
    await env.render(h(Probe, { pending: 0, draft: "b" }));
    assert.deepEqual(sent, []);
  } finally {
    await env.clean();
  }
});
