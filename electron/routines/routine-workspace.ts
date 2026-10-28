import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../app/app-context";
import { coworkFolderGrants } from "../workspace/cowork-folders";
import { routineEnvironmentKey } from "../../shared/routine-environment";
import {
  routineWorkspaceMessages as messages,
  type RoutineWorkspaceDiagnostics,
} from "../../shared/routine-workspace";
import { shQuote, checkRemotePath } from "../ssh/remote-scripts";

/** Only the saved, account-owned task/project supplies filesystem paths. */
export function inspectRoutineWorkspace(
  ctx: AppContext,
  taskId: string,
): RoutineWorkspaceDiagnostics | Promise<RoutineWorkspaceDiagnostics> {
  const task = ctx.scheduler?.list().find((value) => value.id === taskId);
  if (!task) throw new Error("This scheduled task no longer exists.");
  const environment = task.environment;
  const host =
    environment?.kind === "ssh"
      ? "ssh"
      : environment?.kind === "space"
        ? "space"
        : "local";
  const project = ctx.store.projects.find(
    (value) =>
      value.id === task.projectId &&
      !value.archivedAt &&
      routineEnvironmentKey(value.environment) ===
        routineEnvironmentKey(environment),
  );
  const selected = [
    task.cwd,
    ...(task.mode === "cowork" && project
      ? [project.cwd, ...(project.additionalFolders ?? [])]
      : []),
  ].filter((value): value is string => Boolean(value));
  // The working folder may be the project's primary folder; that identity
  // is one folder, not an invalid duplicate in the person's selection.
  if (task.cwd && project?.cwd === task.cwd) selected.splice(1, 1);
  const problems: RoutineWorkspaceDiagnostics["problems"] = [];
  if (selected.length > 16) problems.push("too-many");
  if (new Set(selected).size !== selected.length) problems.push("duplicate");
  const seen = new Set<string>();
  const grants = coworkFolderGrants(ctx.store.root);
  const spaceRoot =
    host === "space" && environment?.kind === "space"
      ? path.resolve(ctx.store.root, "spaces", environment.spaceId, "workspace")
      : undefined;
  const inside = (file: string, root: string) => {
    const relative = path.relative(root, file);
    return (
      relative === "" ||
      (!relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };
  const folders = [...new Set(selected)].slice(0, 32).map((folder) => {
    const row: RoutineWorkspaceDiagnostics["folders"][number] = {
      path: folder,
      state: "unavailable",
    };
    // A local fs.stat must never inspect a path belonging to an SSH host.
    if (host === "ssh") return { ...row, state: "not-checked" as const };
    if (
      !path.isAbsolute(folder) ||
      (spaceRoot && !inside(path.resolve(folder), spaceRoot))
    ) {
      if (!problems.includes("unsupported")) problems.push("unsupported");
      return { ...row, message: messages.unsupported };
    }
    try {
      const real = fs.realpathSync(folder);
      if (spaceRoot && !inside(real, fs.realpathSync(spaceRoot))) {
        if (!problems.includes("unsupported")) problems.push("unsupported");
        return { ...row, message: messages.unsupported };
      }
      if (!fs.statSync(real).isDirectory())
        return { ...row, state: "missing" as const, message: messages.missing };
      if (seen.has(real) && !problems.includes("duplicate"))
        problems.push("duplicate");
      seen.add(real);
      fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
      if (task.mode === "cowork" && !spaceRoot) {
        const access = grants.access(real, undefined, project?.id);
        if (access.state === "refused") {
          if (!problems.includes("unsupported")) problems.push("unsupported");
          return { ...row, message: access.reason };
        }
        if (
          !grants.routineAllowed(task.id, real) &&
          access.state !== "granted" &&
          access.state !== "trusted"
        )
          return {
            ...row,
            state: "permission-required" as const,
            message: messages.permission,
          };
      }
      return { ...row, state: "ready" as const };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        ...row,
        state:
          code === "ENOENT" || code === "ENOTDIR"
            ? ("missing" as const)
            : code === "EACCES" || code === "EPERM"
              ? ("permission-required" as const)
              : ("unavailable" as const),
        message:
          code === "ENOENT" || code === "ENOTDIR"
            ? messages.missing
            : code === "EACCES" || code === "EPERM"
              ? messages.permission
              : messages.unavailable,
      };
    }
  });
  const result: RoutineWorkspaceDiagnostics = {
    taskId,
    host,
    folders,
    problems,
  };
  if (host !== "ssh" || environment?.kind !== "ssh" || !folders.length)
    return result;
  const store = ctx.store,
    service = ctx.services.ssh,
    hostId = environment.hostId;
  // Merely opening detail never establishes a connection or falls back to
  // this computer's filesystem. Reconnect remains an explicit user action.
  if (!service?.allowed() || !service.hosts.get(hostId)) return result;
  const connection = service.existing(hostId);
  if (!connection || connection.status.state !== "ready")
    return { ...result, canReconnect: true };
  let paths: string[];
  try {
    paths = folders.map((folder) => checkRemotePath(folder.path));
  } catch {
    return {
      ...result,
      problems: [...new Set([...problems, "unsupported" as const])],
    };
  }
  const script = `for folder in ${paths.map(shQuote).join(" ")}; do\nif [ ! -d "$folder" ]; then printf 'missing\\n'; elif [ -r "$folder" ] && [ -x "$folder" ]; then printf 'ready\\n'; else printf 'permission-required\\n'; fi\ndone`;
  const current = () =>
    ctx.store === store &&
    ctx.services.ssh === service &&
    service.existing(hostId) === connection &&
    ctx.scheduler
      ?.list()
      .some(
        (value) =>
          value.id === task.id &&
          value.updatedAt === task.updatedAt &&
          routineEnvironmentKey(value.environment) ===
            routineEnvironmentKey(environment),
      );
  return connection.exec(script, { timeoutMs: 15000 }).then((reply) => {
    if (!current()) throw Error("This task session changed. Try again.");
    const states = reply.stdout.trim().split(/\r?\n/);
    if (
      reply.code !== 0 ||
      states.length !== folders.length ||
      states.some(
        (value) => !["ready", "missing", "permission-required"].includes(value),
      )
    )
      throw Error(messages.unavailable);
    return {
      ...result,
      folders: folders.map((folder, index) => ({
        ...folder,
        state: states[index] as "ready" | "missing" | "permission-required",
        ...(states[index] === "missing"
          ? { message: messages.missing }
          : states[index] === "permission-required"
            ? { message: messages.permission }
            : {}),
      })),
    };
  });
}
