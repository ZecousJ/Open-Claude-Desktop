import test from "node:test";
import assert from "node:assert/strict";
import type { execFile } from "node:child_process";
import { linuxTraySupported } from "../../electron/app/linux-tray";

const answering = (error: Error | null, stdout: string) =>
  ((_file: string, _args: string[], _options: object, done: Function) =>
    done(error, stdout, "")) as unknown as typeof execFile;

test("a Linux desktop shows tray icons when a StatusNotifier host is on the bus", async () => {
  assert.equal(await linuxTraySupported(answering(null, "(true,)\n")), true);
  assert.equal(await linuxTraySupported(answering(null, "(false,)\n")), false);
  // No gdbus: unknown, taken as shown.
  assert.equal(
    await linuxTraySupported(answering(new Error("ENOENT"), "")),
    true,
  );
});
