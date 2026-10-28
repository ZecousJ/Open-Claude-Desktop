import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SimulatorBuilds,
  buildNameProblem,
  buildStatusText,
  classifyBuildLine,
  resolveContainer,
} from "../../electron/simulators/builds";
import { simulatorExtension } from "../../electron/simulators/tools";
import { simulatorToolSpecs } from "../../electron/simulators/tool-schemas";
import type { SimulatorService } from "../../electron/simulators/service";
import { FakeRunner } from "../support/simulators-fakes";

const temp = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "claudex-builds-test-"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("build lines, names and containers are checked the original's way", () => {
  assert.equal(
    classifyBuildLine("/a/App.swift:12:5: error: cannot find 'x' in scope"),
    "error",
  );
  assert.equal(
    classifyBuildLine("xcodebuild: error: Unable to find a destination"),
    "error",
  );
  assert.equal(
    classifyBuildLine("/a/App.swift:3:1: warning: unused"),
    "warning",
  );
  assert.equal(classifyBuildLine("CompileSwift normal arm64"), undefined);
  assert.equal(
    buildNameProblem("-quiet", "scheme"),
    "'scheme' can't start with '-'.",
  );
  assert.equal(buildNameProblem("MyApp", "scheme"), undefined);
  const root = temp();
  try {
    const project = path.join(root, "My App.xcodeproj");
    fs.mkdirSync(project);
    assert.equal(
      resolveContainer(project, "project"),
      fs.realpathSync(project),
    );
    assert.throws(
      () => resolveContainer("App.xcodeproj", "project"),
      /absolute path/,
    );
    assert.throws(
      () => resolveContainer(project, "workspace"),
      /\.xcworkspace/,
    );
    assert.throws(
      () => resolveContainer(path.join(root, "Gone.xcodeproj"), "project"),
      /doesn't exist/,
    );
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

test("a build runs xcodebuild into its own derived data, keeps its errors and finds the app", async () => {
  const root = temp();
  try {
    const runner = new FakeRunner(() => "");
    const builds = new SimulatorBuilds({
      runner,
      root: () => root,
      now: () => 1000,
    });
    const build = await builds.start({
      containerPath: "/work/App.xcodeproj",
      containerKind: "project",
      scheme: "App",
      configuration: "Debug",
      destination: "generic/platform=iOS Simulator",
    });
    const process = runner.started[0];
    assert.equal(process.file, "xcrun");
    assert.deepEqual(process.args.slice(0, 9), [
      "xcodebuild",
      "-project",
      "/work/App.xcodeproj",
      "-scheme",
      "App",
      "-configuration",
      "Debug",
      "-destination",
      "generic/platform=iOS Simulator",
    ]);
    assert.ok(process.args.includes("-skipMacroValidation"));
    await assert.rejects(
      () => builds.start({ ...build }),
      /already running \(b-[0-9a-f]+, started 0s ago, 0 errors so far\)/,
    );
    process.emit("/work/App.swift:3:1: warning: unused");
    process.emit("CompileSwift normal");
    const products = path.join(
      build.derivedDataPath,
      "Build",
      "Products",
      "Debug-iphonesimulator",
      "App.app",
    );
    fs.mkdirSync(products, { recursive: true });
    process.finish(0);
    await settle();
    const done = builds.status(build.id)!;
    assert.equal(done.state, "succeeded");
    assert.equal(done.warningCount, 1);
    assert.equal(done.appPath, products);
    assert.match(
      buildStatusText(done, 1000),
      /succeeded.*Built app: .*App\.app/s,
    );
    // Stream creation and its first write can both lag on a busy machine.
    for (
      let i = 0;
      i < 40 &&
      (!fs.existsSync(build.logPath) ||
        !/CompileSwift normal/.test(fs.readFileSync(build.logPath, "utf8")));
      i++
    )
      await settle();
    assert.match(fs.readFileSync(build.logPath, "utf8"), /CompileSwift normal/);

    const failing = await builds.start({ ...build });
    runner.started[1].emit(
      "/work/App.swift:12:5: error: cannot find 'x' in scope",
    );
    runner.started[1].finish(65);
    await settle();
    const failed = builds.status(failing.id)!;
    assert.equal(failed.state, "failed");
    assert.match(
      buildStatusText(failed, 1000),
      /failed .* 1 errors \(exit code 65\).*cannot find 'x'/s,
    );
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

test("the iOS server offers build; a build asks the person first and a refusal starts nothing", async () => {
  const ios = simulatorToolSpecs(["ios"])[0];
  assert.ok(
    ios.type === "namespace" && ios.tools.some((tool) => tool.name === "build"),
  );
  const android = simulatorToolSpecs(["android"])[0];
  assert.ok(
    android.type === "namespace" &&
      !android.tools.some((tool) => tool.name === "build"),
  );

  const root = temp();
  try {
    const project = path.join(root, "App.xcodeproj");
    fs.mkdirSync(project);
    const runner = new FakeRunner(() => "");
    const builds = new SimulatorBuilds({ runner, root: () => root });
    const asked: string[] = [];
    let reply = "decline";
    const extension = simulatorExtension({
      service: () =>
        ({
          approveTools: async () => "granted",
          buildDestination: async () => "platform=iOS Simulator,id=ABC",
        }) as unknown as SimulatorService,
      builds: () => builds,
      ask: async (_id, params) => {
        asked.push(String(params.message));
        return { action: reply };
      },
      unattended: () => false,
    });
    const call = (args: Record<string, unknown>) =>
      extension.handleDynamicTool!({
        namespace: "claudex_ios_simulator",
        tool: "build",
        arguments: args,
        conversation: { id: "c1", mode: "code" },
      } as never);
    const first = await call({
      action: "build",
      project_path: project,
      scheme: "App",
    });
    assert.equal(first!.success, false);
    assert.match(
      asked[0],
      /^Allow Claudex to build App \(Debug\)\?\n\$ xcodebuild -project /,
    );
    assert.equal(runner.started.length, 0);
    reply = "accept";
    const started = await call({
      action: "build",
      project_path: project,
      scheme: "App",
    });
    assert.equal(started!.success, true);
    const id = /Build (b-[0-9a-f]+) started/.exec(
      (started!.contentItems[0] as { text: string }).text,
    )![1];
    const status = await call({ action: "build_status", build_id: id });
    assert.match(
      (status!.contentItems[0] as { text: string }).text,
      /is running/,
    );
    const missing = await call({ action: "build", scheme: "App" });
    assert.match(
      (missing!.contentItems[0] as { text: string }).text,
      /exactly one of project_path/,
    );
    builds.dispose();
    await settle();
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});
