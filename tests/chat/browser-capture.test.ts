import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CdpDriver } from "../../electron/browser/cdp";

test("captures serialize per page, recover after failure and leave other operations independent", async () => {
  const sent: string[] = [];
  let rejectFirst!: (error: Error) => void;
  const debuggerFor = (page: string) =>
    Object.assign(new EventEmitter(), {
      isAttached: () => true,
      attach() {},
      detach() {},
      sendCommand: async (method: string, params?: { frame?: number }) => {
        sent.push(`${page}:${method}:${params?.frame ?? ""}`);
        if (
          page === "one" &&
          method === "Page.captureScreenshot" &&
          params?.frame === 1
        )
          return new Promise((_, reject) => {
            rejectFirst = reject;
          });
        return { data: page };
      },
    });
  const one = new CdpDriver(debuggerFor("one"));
  const two = new CdpDriver(debuggerFor("two"));
  const failed = one.captureScreenshot({ frame: 1 });
  const rejected = assert.rejects(failed, /capture failed/);
  const next = one.captureScreenshot({ frame: 2 });
  assert.deepEqual(await two.captureScreenshot({ frame: 1 }), { data: "two" });
  assert.deepEqual(await one.send("Page.getLayoutMetrics"), { data: "one" });
  assert.ok(!sent.includes("one:Page.captureScreenshot:2"));
  rejectFirst(Error("capture failed"));
  await rejected;
  assert.deepEqual(await next, { data: "one" });
  assert.equal(
    sent.filter((call) => call === "one:Page.captureScreenshot:2").length,
    1,
  );
});
