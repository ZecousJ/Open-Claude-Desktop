import { onThisMachine } from "../../shared/types";
import {
  type DynamicToolResult,
  type EngineExtension,
} from "../engine/engine-extensions";
import { appLogLine, bundleIdPattern } from "./app-logs";
import { buildNameProblem, buildStatusText, resolveContainer } from "./builds";

import { simulatorNamespaces } from "./tool-schemas";
import { logsArgumentSchema, buildArgumentSchema } from "./tool-schemas";
import type { SimulatorExtensionDeps } from "./tools";

/** The build tool: 'build' asks the person, then starts; 'build_status' reports. */
export async function buildCall(
  call: Parameters<NonNullable<EngineExtension["handleDynamicTool"]>>[0],
  deps: SimulatorExtensionDeps,
): Promise<DynamicToolResult> {
  const service = deps.service();
  const builds = deps.builds?.();
  if (!service || !builds)
    return refusal(
      "Builds aren't available here. Build with xcodebuild directly instead.",
    );
  if (
    call.conversation.mode !== "code" ||
    !onThisMachine(call.conversation.environment) ||
    deps.unattended(call.conversation.id)
  )
    return refusal("Builds can only run in a Code session on this computer.");
  const parsed = buildArgumentSchema.safeParse(call.arguments);
  if (!parsed.success)
    return refusal(
      `Invalid arguments: ${parsed.error.issues
        .slice(0, 3)
        .map(
          (issue) => `${issue.path.join(".") || "arguments"} ${issue.message}`,
        )
        .join("; ")}`,
    );
  const args = parsed.data;
  if (args.action === "build_status") {
    if (!args.build_id)
      return refusal("'build_status' requires build_id (returned by 'build').");
    const build = builds.status(args.build_id);
    if (!build)
      return refusal(
        `Unknown build id '${args.build_id.slice(0, 80)}'. Start a build with the 'build' action.`,
      );
    const text = buildStatusText(build, Date.now());
    return build.state === "failed" ? refusal(text) : answer(text);
  }
  if ((args.project_path === undefined) === (args.workspace_path === undefined))
    return refusal(
      "'build' requires exactly one of project_path (.xcodeproj) or workspace_path (.xcworkspace).",
    );
  if (args.device && args.udid) return refusal("Pass only one of device/udid.");
  const containerKind = args.project_path ? "project" : "workspace";
  let containerPath: string;
  try {
    containerPath = resolveContainer(
      (args.project_path ?? args.workspace_path)!,
      containerKind,
    );
  } catch (error) {
    return refusal(error instanceof Error ? error.message : String(error));
  }
  if (!args.scheme)
    return refusal(
      `'build' requires scheme. List the schemes with: xcodebuild -list ${containerKind === "project" ? "-project" : "-workspace"} ${containerPath}`,
    );
  const configuration = args.configuration ?? "Debug";
  const problem =
    buildNameProblem(args.scheme, "scheme") ??
    buildNameProblem(configuration, "configuration");
  if (problem) return refusal(problem);
  let destination: string;
  try {
    destination = await service.buildDestination(
      call.conversation.id,
      args.device ?? args.udid,
    );
  } catch (error) {
    return refusal(error instanceof Error ? error.message : String(error));
  }
  if (!deps.ask)
    return refusal(
      "Builds need the person's approval, which can't be asked here.",
    );
  const reply = await deps.ask(call.conversation.id, {
    serverName: simulatorNamespaces.ios,
    mode: "form",
    message: [
      `Allow Claudex to build ${args.scheme} (${configuration})?`,
      `$ xcodebuild ${containerKind === "project" ? "-project" : "-workspace"} ${containerPath} -scheme ${args.scheme} -configuration ${configuration} -destination '${destination}' -skipMacroValidation build`,
      "Runs on this computer outside the sandbox. Headless builds skip Xcode's Swift-macro trust prompt, so this also trusts the Swift-package macros in the project's dependencies.",
    ].join("\n"),
    requestedSchema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["once"], enumNames: ["Allow"] },
      },
      required: ["decision"],
    },
  });
  if (reply?.action !== "accept")
    return refusal(
      "The user didn't allow the build. Don't start it again unless they ask.",
    );
  try {
    const build = await builds.start({
      containerPath,
      containerKind,
      scheme: args.scheme,
      configuration,
      destination,
    });
    return answer(
      `Build ${build.id} started: ${args.scheme} (${configuration}) for ${destination}. Full log: ${build.logPath}\nNote: headless builds pass -skipMacroValidation, so Swift-package macros in this project's dependencies run without Xcode's per-package trust prompt.\nPoll {"action": "build_status", "build_id": "${build.id}"} for progress; a first build can take minutes, incremental rebuilds are much faster.`,
    );
  } catch (error) {
    return refusal(
      `build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The logs tool: 'read' the app's captured log, or its 'crash_report'. */
export async function logsCall(
  call: Parameters<NonNullable<EngineExtension["handleDynamicTool"]>>[0],
  deps: SimulatorExtensionDeps,
): Promise<DynamicToolResult> {
  const service = deps.service();
  const logs = deps.appLogs?.();
  if (!service || !logs) return refusal("App logs aren't available here.");
  if (
    call.conversation.mode !== "code" ||
    !onThisMachine(call.conversation.environment) ||
    deps.unattended(call.conversation.id)
  )
    return refusal(
      "App logs can only be read in a Code session on this computer.",
    );
  const parsed = logsArgumentSchema.safeParse(call.arguments);
  if (!parsed.success)
    return refusal(
      `Invalid arguments: ${parsed.error.issues
        .slice(0, 3)
        .map(
          (issue) => `${issue.path.join(".") || "arguments"} ${issue.message}`,
        )
        .join("; ")}`,
    );
  const args = parsed.data;
  if (args.device && args.udid) return refusal("Pass only one of device/udid.");
  if (args.bundle_id && !bundleIdPattern.test(args.bundle_id))
    return refusal(
      `'${args.bundle_id.slice(0, 80)}' isn't a bundle identifier.`,
    );
  let udid: string;
  try {
    udid = (
      await service.bootedDevice(
        "ios",
        call.conversation.id,
        args.device ?? args.udid,
      )
    ).id;
  } catch (error) {
    return refusal(error instanceof Error ? error.message : String(error));
  }
  let session = args.bundle_id
    ? logs.session(udid, args.bundle_id)
    : logs.latest(udid);
  if (!session && args.bundle_id && args.action === "read") {
    try {
      session = await logs.start(udid, args.bundle_id);
    } catch (error) {
      return refusal(
        `Couldn't start capturing ${args.bundle_id}: ${error instanceof Error ? error.message : String(error)}. Is it installed on the simulator?`,
      );
    }
    return answer(
      `Started capturing the log of ${args.bundle_id} (process ${session.executable}). Nothing is captured yet; use the app, then call 'read' again.\nNext cursor: since=${session.session}:0`,
    );
  }
  if (!session)
    return refusal(
      "No app log is being captured on this simulator. Launch the app with the 'control' tool ('launch'), or pass the running app's bundle_id to 'read'.",
    );
  if (args.action === "crash_report") {
    const report = logs.crashReport(session);
    return answer(
      report
        ? `Crash report for ${session.bundleId} (${report.file}):\n${report.summary}`
        : `No crash report for ${session.bundleId} since it was launched.`,
    );
  }
  const result = logs.read(session, {
    tail: args.tail,
    since: args.since,
    level: args.level,
    filter: args.filter,
  });
  const lines = result.entries.map(appLogLine);
  return answer(
    [
      lines.length
        ? `${lines.length} entries from ${session.bundleId}${result.dropped ? ` (${result.dropped} older ones not shown)` : ""}:`
        : `No matching entries from ${session.bundleId}${args.since ? " since the cursor" : ""}.`,
      ...lines,
      ...(result.ended ? [`Capture stopped: ${result.ended}`] : []),
      `Next cursor: since=${result.cursor}`,
    ].join("\n"),
  );
}

export const refusal = (message: string): DynamicToolResult => ({
  success: false,
  contentItems: [{ type: "inputText", text: message }],
});

export const answer = (message: string): DynamicToolResult => ({
  success: true,
  contentItems: [{ type: "inputText", text: message }],
});
