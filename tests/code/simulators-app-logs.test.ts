import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AppLogs,
  summarizeCrashReport,
} from "../../electron/simulators/app-logs";
import { simulatorExtension } from "../../electron/simulators/tools";
import type { SimulatorService } from "../../electron/simulators/service";
import { FakeRunner } from "../support/simulators-fakes";

const udid = "33333333-3333-3333-3333-333333333333";
const event = (
  message: string,
  type = "Default",
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    eventType: "logEvent",
    eventMessage: message,
    messageType: type,
    processID: 42,
    process: "MyApp",
    timestamp: "2026-10-15 09:41:07.123456+0000",
    subsystem: "com.example.MyApp",
    category: "net",
    ...extra,
  });

test("app logs: capture follows the app's process, reads honour level, filter and cursor", async () => {
  const runner = new FakeRunner((file, args) =>
    args[1] === "get_app_container"
      ? "/Sim/App.app\n"
      : file === "plutil"
        ? "MyApp\n"
        : "",
  );
  const logs = new AppLogs({ runner, now: () => 1000 });
  const session = await logs.start(udid, "com.example.MyApp");
  assert.deepEqual(runner.started[0].args.slice(-2), [
    "--predicate",
    'process == "MyApp"',
  ]);
  const process = runner.started[0];
  process.emit(event("debug chatter", "Debug"));
  process.emit(event("request finished", "Info"));
  process.emit(event("failed to load", "Error"));
  const first = logs.read(session, {});
  assert.deepEqual(
    first.entries.map((e) => e.message),
    ["request finished", "failed to load"],
  );
  assert.equal(first.cursor, `${session.session}:3`);
  assert.deepEqual(
    logs.read(session, { filter: "FAILED" }).entries.map((e) => e.message),
    ["failed to load"],
  );
  process.emit(event("later", "Default"));
  assert.deepEqual(
    logs.read(session, { since: first.cursor }).entries.map((e) => e.message),
    ["later"],
  );
  assert.equal(logs.read(session, { since: "stale:2" }).entries.length, 3);
  logs.dispose();
});

test("a crash report is the newest .ips for the app since launch, as its header and crashed thread", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ips-"));
  try {
    const header = JSON.stringify({
      app_name: "MyApp",
      bundleID: "com.example.MyApp",
      app_version: "1.0",
    });
    const body = JSON.stringify({
      exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
      faultingThread: 0,
      usedImages: [{ name: "MyApp" }],
      threads: [
        {
          frames: [
            {
              imageIndex: 0,
              symbol: "ContentView.body.getter",
              symbolLocation: 12,
            },
          ],
        },
      ],
    });
    fs.writeFileSync(path.join(folder, "MyApp-2026.ips"), `${header}\n${body}`);
    fs.writeFileSync(
      path.join(folder, "Other.ips"),
      `${JSON.stringify({ app_name: "Other" })}\n{}`,
    );
    const logs = new AppLogs({
      runner: new FakeRunner(() => ""),
      reportsFolder: () => folder,
    });
    const session = {
      session: "s",
      udid,
      bundleId: "com.example.MyApp",
      executable: "MyApp",
      launchedAt: Date.now() - 5000,
    } as Parameters<AppLogs["crashReport"]>[0];
    const report = logs.crashReport(session)!;
    assert.match(report.summary, /Exception: EXC_BAD_ACCESS SIGSEGV/);
    assert.match(
      report.summary,
      /Crashed thread 0:\n 0 MyApp\s+ContentView\.body\.getter \+ 12/,
    );
    assert.equal(
      logs.crashReport({ ...session, bundleId: "x", executable: "y" }),
      undefined,
    );
    assert.match(summarizeCrashReport("not json\nat all"), /not json/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("the logs tool reads the app Claude launched and says how to start a capture otherwise", async () => {
  const runner = new FakeRunner((file, args) =>
    args[1] === "get_app_container"
      ? "/Sim/App.app\n"
      : file === "plutil"
        ? "MyApp\n"
        : "",
  );
  const logs = new AppLogs({ runner });
  const extension = simulatorExtension({
    service: () =>
      ({
        bootedDevice: async () => ({ id: udid }),
      }) as unknown as SimulatorService,
    appLogs: () => logs,
    unattended: () => false,
  });
  const call = (args: Record<string, unknown>) =>
    extension.handleDynamicTool!({
      namespace: "claudex_ios_simulator",
      tool: "logs",
      arguments: args,
      conversation: { id: "c1", mode: "code" },
    } as never);
  const text = (result: Awaited<ReturnType<typeof call>>) =>
    (result!.contentItems[0] as { text: string }).text;
  assert.match(
    text(await call({ action: "read" })),
    /No app log is being captured/,
  );
  assert.match(
    text(await call({ action: "read", bundle_id: "com.example.MyApp" })),
    /Started capturing/,
  );
  runner.started[0].emit(event("hello", "Info"));
  assert.match(
    text(await call({ action: "read" })),
    /1 entries from com\.example\.MyApp:\n.*hello\nNext cursor: since=/,
  );
  assert.match(
    text(await call({ action: "crash_report" })),
    /No crash report|Crash report/,
  );
  assert.match(
    text(await call({ action: "read", bundle_id: "bad id!" })),
    /isn't a bundle identifier/,
  );
  logs.dispose();
});
