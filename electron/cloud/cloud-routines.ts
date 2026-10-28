import { RoutineMigration } from "./routine-migration";
import {
  sameMigrationOwner,
  type RoutineMigrationContext,
} from "./routine-migration-registry";
import type { RoutineMigrationRequest } from "../../shared/routine-migration";
import { routineWithBackend } from "../routines/routine-execution-metadata";
import type {
  Routine,
  RoutineCapabilities,
  RoutineInput,
  RoutineRepeat,
  RoutineListResult,
  RoutineDetailResult,
  RoutineBackend,
  RoutineSourceState,
} from "../../shared/routines";
import type { CloudCalls } from "./cloud-router";
import {
  routineNameProblem,
  routineReadFailure,
  validRoutineListResult,
} from "../../shared/routines";

type Handler = (...args: any[]) => any;
const routineCalls = new Set([
  "listSchedules",
  "querySchedules",
  "readSchedule",
  "saveSchedule",
  "deleteSchedule",
  "runSchedule",
  "routineRuns",
  "routineRunsPage",
  "routineSchedulePreview",
  "markRoutineRunRead",
  "removeRoutineApproval",
  "securityFindings",
  "triageSecurityFinding",
  "routineCapabilities",
  "routineWorkspace",
  "routineBrowserPermissions",
  "clearRoutineBrowserPermissions",
  "routineMigration",
  "migrateRoutine",
  "beginRoutineMigration",
  "restoreRoutineMigration",
  "importRoutineMigration",
  "deleteRoutineMigration",
]);

/** Local/remote task backends. */
export class CloudRoutines {
  private handlers = new Map<string, Handler>();
  private local: Routine[] = [];
  private remote: Routine[] = [];
  private generation = 0;
  private queryRevision = 0;
  private locatedIds = new Map<string, RoutineBackend>();
  private saves: Promise<unknown> = Promise.resolve();

  constructor(
    private client: () => CloudCalls | undefined,
    private migrationContext?: () => RoutineMigrationContext | undefined,
  ) {}

  private filtered(tasks: Routine[]) {
    const context = this.migrationContext?.();
    if (!context) return tasks;
    const hidden = new Set(
      context.journal
        .list()
        .filter(
          (record) =>
            sameMigrationOwner(record.owner, context.owner) &&
            ["cloud", "reverting"].includes(record.state),
        )
        .map((record) => record.original.id),
    );
    return tasks.filter(
      (task) => task.executionLocation !== "local" || !hidden.has(task.id),
    );
  }

  private migration(client: CloudCalls | undefined, generation: number) {
    const context = this.migrationContext?.();
    if (!context || !client) return undefined;
    const handlers = new Map(this.handlers);
    const current = () => {
      const live = this.migrationContext?.();
      return (
        this.isCurrent(generation) &&
        this.client() === client &&
        Boolean(live && sameMigrationOwner(context.owner, live.owner))
      );
    };
    return new RoutineMigration({
      context,
      current,
      call: async (side, method, args) => {
        if (!current())
          throw new Error("The signed-in account changed. Try again.");
        if (side === "remote") return client.call(method, args);
        const handler = handlers.get(method);
        if (!handler)
          throw new Error(
            "Scheduled task migration is unavailable on this computer.",
          );
        return handler(...args);
      },
    });
  }

  reset() {
    this.generation++;
    this.queryRevision++;
    this.locatedIds.clear();
    this.local = [];
    this.remote = [];
    this.saves = Promise.resolve();
  }

  private visible() {
    const connected = !!this.client();
    return this.filtered([...this.local, ...(connected ? this.remote : [])]);
  }

  private isCurrent(generation: number) {
    // The real client getter may synchronously reset the router while
    // lazily activating another account or service URL.
    this.client();
    return generation === this.generation;
  }

  private assertCurrent(generation: number) {
    if (!this.isCurrent(generation))
      throw new Error(
        "Couldn’t connect. Check your internet connection, then try again.",
      );
  }

  update(tasks: Routine[], location: "local" | "remote") {
    this[location] = tasks.map((task) => ({
      ...task,
      executionLocation: location,
    }));
    return this.visible();
  }

  route(name: string, local: Handler): Handler | undefined {
    if (!routineCalls.has(name)) return;
    this.handlers.set(name, local);
    if (
      name === "routineBrowserPermissions" ||
      name === "clearRoutineBrowserPermissions"
    )
      return async (id: string, source?: RoutineBackend) => {
        if (source !== undefined && source !== "local" && source !== "remote")
          throw new Error("Invalid scheduled task source.");
        const client = this.client(),
          generation = this.generation;
        const side =
          source ??
          this.locatedIds.get(id) ??
          (this.remote.some((task) => task.id === id) ? "remote" : "local");
        if (side === "remote" && !client)
          throw new Error(
            "Couldn’t connect. Check your internet connection, then try again.",
          );
        const result = await (side === "remote"
          ? client!.call(name, [id])
          : local(id));
        this.assertCurrent(generation);
        return result;
      };
    if (name === "routineMigration")
      return async (id: string, source?: RoutineBackend) => {
        const client = this.client();
        const generation = this.generation;
        const migration = this.migration(client, generation);
        if (!migration)
          return {
            source: source ?? "local",
            toCloud: { ok: false, reasons: ["unavailable"] },
            toLocal: { ok: false, reasons: ["unavailable"] },
          };
        return migration.eligibility(id, source);
      };
    if (name === "migrateRoutine")
      return (input: RoutineMigrationRequest) => {
        const client = this.client();
        const generation = this.generation;
        const captured = structuredClone(input);
        const result = this.saves.then(async () => {
          this.assertCurrent(generation);
          const migration = this.migration(client, generation);
          if (!migration)
            throw new Error(
              "Scheduled task migration is unavailable on this computer.",
            );
          const moved = await migration.move(captured);
          this.assertCurrent(generation);
          const localRows = (await this.handlers.get(
            "listSchedules",
          )!()) as Routine[];
          this.assertCurrent(generation);
          this.local = localRows.map((task) =>
            routineWithBackend(task, "local"),
          );
          if (captured.direction === "to-cloud")
            this.remote = [
              ...this.remote.filter((task) => task.id !== moved.toId),
              moved.task,
            ];
          else
            this.remote = this.remote.filter(
              (task) => task.id !== moved.fromId,
            );
          this.locatedIds.set(
            moved.toId,
            captured.direction === "to-cloud" ? "remote" : "local",
          );
          return moved;
        });
        this.saves = result.catch(() => {});
        return result;
      };
    if (name === "querySchedules")
      return async (): Promise<RoutineListResult> => {
        const client = this.client();
        const generation = this.generation;
        const revision = ++this.queryRevision;
        const cached = { local: [...this.local], remote: [...this.remote] };
        const sides: RoutineBackend[] = client
          ? ["local", "remote"]
          : ["local"];
        const reads = await Promise.allSettled(
          sides.map((side) =>
            Promise.resolve().then(() =>
              side === "local" ? local() : client!.call(name),
            ),
          ),
        );
        if (!this.isCurrent(generation))
          return {
            tasks: [],
            sources: sides.map((source) => ({ source, status: "error" })),
          };
        const tasks: Routine[] = [];
        const sources: RoutineSourceState[] = [];
        reads.forEach((read, index) => {
          const source = sides[index];
          const value =
            read.status === "fulfilled"
              ? (read.value as RoutineListResult)
              : undefined;
          if (
            validRoutineListResult(value) &&
            value.sources.every((state) => state.status === "ready")
          ) {
            const rows = value.tasks.map((task) =>
              routineWithBackend(task, source),
            );
            tasks.push(...rows);
            sources.push({ source, status: "ready" });
            if (revision === this.queryRevision) {
              this[source] = rows;
              for (const task of rows) this.locatedIds.set(task.id, source);
            }
          } else {
            const failure =
              read.status === "rejected" ? read.reason : undefined;
            const state = validRoutineListResult(value)
              ? value.sources.find((state) => state.status !== "ready")
              : undefined;
            tasks.push(
              ...cached[source].map((task) =>
                routineWithBackend(task, source, true),
              ),
            );
            sources.push({
              source,
              status: state?.status ?? routineReadFailure(failure),
              message:
                state?.message ??
                (failure instanceof Error ? failure.message : undefined),
            });
          }
        });
        return { tasks: this.filtered(tasks), sources };
      };
    if (name === "readSchedule")
      return async (
        id: string,
        source?: RoutineBackend,
      ): Promise<RoutineDetailResult> => {
        if (source !== undefined && source !== "local" && source !== "remote")
          return { status: "error" };
        const client = this.client();
        const generation = this.generation;
        const sides: RoutineBackend[] = source
          ? [source]
          : client
            ? ["local", "remote"]
            : ["local"];
        const reads = await Promise.all(
          sides.map(async (side) => {
            try {
              if (side === "remote" && !client)
                throw new Error(
                  "Couldn’t connect. Check your internet connection, then try again.",
                );
              const result = (await (side === "local"
                ? local(id)
                : client!.call(name, [id]))) as RoutineDetailResult;
              if (
                !result ||
                !["ready", "missing", "refused", "error"].includes(
                  result.status,
                ) ||
                (result.status === "ready" && result.task?.id !== id)
              )
                throw new Error("Couldn’t load scheduled tasks");
              return { side, result };
            } catch (error) {
              return {
                side,
                result: {
                  status: routineReadFailure(error),
                  message: error instanceof Error ? error.message : undefined,
                } as RoutineDetailResult,
              };
            }
          }),
        );
        if (!this.isCurrent(generation)) return { status: "error" };
        const found = reads.filter((read) => read.result.status === "ready");
        if (found.length === 1) {
          const { side, result } = found[0];
          if (result.status !== "ready") return { status: "error" };
          this.locatedIds.set(id, side);
          return {
            status: "ready",
            task: routineWithBackend(result.task, side),
          };
        }
        if (found.length > 1) return { status: "error" };
        return (
          reads.find((read) => read.result.status === "refused")?.result ??
          reads.find((read) => read.result.status === "error")?.result ?? {
            status: "missing",
          }
        );
      };
    if (name === "routineSchedulePreview")
      return async (repeat: RoutineRepeat, location?: "local" | "remote") => {
        const client = this.client();
        const generation = this.generation;
        if (location === "remote" && !client)
          throw new Error(
            "Couldn’t connect. Check your internet connection, then try again.",
          );
        const preview = await (location === "remote"
          ? client!.call(name, [repeat])
          : local(repeat));
        this.assertCurrent(generation);
        return preview;
      };
    if (name === "routineCapabilities")
      return async (location?: "local" | "remote") => {
        const client = this.client();
        const generation = this.generation;
        const capabilities = (await local()) as RoutineCapabilities;
        this.assertCurrent(generation);
        if (!client) return capabilities;
        try {
          const remote = (await client.call(name)) as RoutineCapabilities;
          this.assertCurrent(generation);
          const sources =
            location === "remote"
              ? remote.sources
              : location === "local"
                ? capabilities.sources
                : capabilities.sources || remote.sources
                  ? [
                      ...new Set([
                        ...(capabilities.sources ?? []),
                        ...(remote.sources ?? []),
                      ]),
                    ]
                  : undefined;
          return {
            ...(location === "remote" ? remote : capabilities),
            computerName: capabilities.computerName,
            ...(sources ? { sources } : {}),
            ...(location === undefined &&
            (capabilities.statuses || remote.statuses)
              ? {
                  statuses: [
                    ...new Set([
                      ...(capabilities.statuses ?? []),
                      ...(remote.statuses ?? []),
                    ]),
                  ],
                }
              : {}),
            remote: true,
          };
        } catch (error) {
          this.assertCurrent(generation);
          if (location === "remote") throw error;
          return capabilities;
        }
      };
    if (name === "listSchedules")
      return async () => {
        const client = this.client();
        const generation = this.generation;
        const localTasks = (await local()) as Routine[];
        if (!this.isCurrent(generation)) return this.visible();
        this.update(localTasks, "local");
        if (client) {
          try {
            const remote = (await client.call(name)) as Routine[];
            if (!this.isCurrent(generation)) return this.visible();
            this.update(remote, "remote");
          } catch {
            // Keep local tasks usable while the cloud is unreachable.
          }
        }
        return this.visible();
      };
    if (name === "saveSchedule")
      return (input: RoutineInput) => {
        const client = this.client();
        const generation = this.generation;
        const captured = structuredClone(input);
        const result = this.saves.then(() => {
          this.assertCurrent(generation);
          return this.save(captured, client, generation);
        });
        this.saves = result.catch(() => {});
        return result;
      };
    return async (id: string, ...args: unknown[]) => {
      const client = this.client();
      const generation = this.generation;
      if (
        !this.remote.some((task) => task.id === id) &&
        this.locatedIds.get(id) !== "remote"
      )
        return local(id, ...args);
      if (!client)
        throw new Error(
          "Couldn’t connect. Check your internet connection, then try again.",
        );
      const result = await client.call(name, [id, ...args]);
      this.assertCurrent(generation);
      if (name === "deleteSchedule")
        this.remote = this.remote.filter((task) => task.id !== id);
      if (name === "runSchedule" && result && typeof result === "object")
        return { ...result, executionLocation: "remote" };
      return result;
    };
  }

  private async save(
    input: RoutineInput,
    client: CloudCalls | undefined,
    generation: number,
  ): Promise<Routine> {
    if (!input || typeof input !== "object")
      throw new Error("Invalid scheduled task.");
    const handlers = new Map(this.handlers);
    const call = async (
      side: "local" | "remote",
      method: string,
      args: unknown[],
    ) => {
      this.assertCurrent(generation);
      if (side === "remote" && !client)
        throw new Error(
          "Couldn’t connect. Check your internet connection, then try again.",
        );
      const result = await (side === "remote"
        ? client!.call(method, args)
        : handlers.get(method)!(...args));
      this.assertCurrent(generation);
      return result;
    };
    this.update(
      (await call("local", "listSchedules", [])) as Routine[],
      "local",
    );
    const known = [...this.local, ...this.remote].find(
      (task) => task.id === input.id,
    );
    const changingName =
      typeof input.name === "string" &&
      (!known || known.name !== input.name.trim());
    if (
      client &&
      (changingName ||
        (input.id && !this.local.some((task) => task.id === input.id)))
    ) {
      this.update(
        (await call("remote", "listSchedules", [])) as Routine[],
        "remote",
      );
    }
    const source = [...this.local, ...this.remote].find(
      (task) => task.id === input.id,
    );
    const actuallyChangingName =
      typeof input.name === "string" &&
      (!source || source.name !== input.name.trim());
    const nameProblem = actuallyChangingName
      ? routineNameProblem(
          input.name,
          [...this.local, ...this.remote],
          input.id,
        )
      : undefined;
    if (nameProblem) throw new Error(nameProblem);
    const location =
      input.executionLocation ?? source?.executionLocation ?? "local";
    if (source && source.executionLocation !== location)
      throw new Error(
        "Where a task runs can’t be changed after it’s created. Use the explicit move action.",
      );
    const fields = { ...input, executionLocation: location };
    if (location === "remote") {
      delete fields.cwd;
      delete fields.environment;
      if (source?.executionLocation !== "remote") fields.alwaysAllowed = [];
    }
    if (!source || source.executionLocation === location) {
      const saved = (await call(location, "saveSchedule", [fields])) as Routine;
      this.update(
        [...this[location].filter((task) => task.id !== saved.id), saved],
        location,
      );
      return { ...saved, executionLocation: location };
    }
    throw new Error(
      "Where a task runs can’t be changed after it’s created. Use the explicit move action.",
    );
  }
}
