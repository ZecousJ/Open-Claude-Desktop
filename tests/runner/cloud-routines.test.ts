import test from "node:test";
import assert from "node:assert/strict";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import type { Routine } from "../../shared/routines";

const task = (id: string, executionLocation?: "local" | "remote") =>
  ({ id, name: id, executionLocation }) as Routine;

test("cloud routines merge lists and route by execution location", async () => {
  const local = [task("local")];
  const remote = [task("remote")];
  const calls: string[] = [];
  const cloud = new CloudRoutines(
    () =>
      ({
        call: async (method: string) => {
          calls.push(method);
          return method === "listSchedules" ? remote : undefined;
        },
      }) as any,
  );
  const handlers = new Map<string, (...args: any[]) => any>([
    ["listSchedules", async () => local],
    ["deleteSchedule", async (id: string) => id],
  ]);
  const route = (name: string) =>
    cloud.route(name, (...args: any[]) => handlers.get(name)!(...args))!;
  const listed = await route("listSchedules")();
  assert.deepEqual(
    listed.map((item: Routine) => [item.id, item.executionLocation]),
    [
      ["local", "local"],
      ["remote", "remote"],
    ],
  );
  assert.equal(await route("deleteSchedule")("remote"), undefined);
  assert.deepEqual(calls, ["listSchedules", "deleteSchedule"]);
});

test("cloud save preserves the project for execution-side validation while stripping local-only paths", async () => {
  let received: any;
  const cloud = new CloudRoutines(
    () =>
      ({
        call: async (method: string, args?: unknown[]) => {
          if (method === "saveSchedule") {
            received = args?.[0];
            return task("remote");
          }
          return [];
        },
      }) as any,
  );
  cloud.route("listSchedules", async () => [])!;
  const save = cloud.route("saveSchedule", async () => task("local"))!;
  await save({
    id: "remote",
    executionLocation: "remote",
    cwd: "/tmp",
    environment: { type: "local" },
    projectId: "p",
    alwaysAllowed: [{ kind: "tool", tool: "x" }],
  } as any);
  assert.equal(received.cwd, undefined);
  assert.equal(received.environment, undefined);
  assert.equal(received.projectId, "p");
  assert.deepEqual(received.alwaysAllowed, []);
});

test("remote capability failure stays an error while undefined/local keep the real local fallback", async () => {
  const local = {
    remote: false,
    email: true,
    slack: false,
    computerName: "Synthetic local Mac",
  };
  const remote = { remote: false, email: false, slack: true };
  let failure: Error | undefined;
  const cloud = new CloudRoutines(
    () =>
      ({
        call: async () => {
          if (failure) throw failure;
          return remote;
        },
      }) as any,
  );
  const capabilities = cloud.route("routineCapabilities", async () => local)!;
  assert.deepEqual(await capabilities(), { ...local, remote: true });
  assert.deepEqual(await capabilities("local"), { ...local, remote: true });
  assert.deepEqual(await capabilities("remote"), {
    ...remote,
    computerName: local.computerName,
    remote: true,
  });
  failure = new Error("Synthetic remote unavailable");
  await assert.rejects(capabilities("remote"), (error) => error === failure);
  assert.deepEqual(await capabilities(), local);
  assert.deepEqual(await capabilities("local"), local);
  const onlyLocal = new CloudRoutines(() => undefined);
  const unchanged = onlyLocal.route("routineCapabilities", async () => local)!;
  assert.deepEqual(await unchanged(), local);
  assert.deepEqual(await unchanged("local"), local);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("reset invalidates a late local list as well as the remote cache", async () => {
  const previousLocal = deferred<Routine[]>();
  let owner = "A",
    fail = false;
  const client = {
    call: async () => {
      if (fail) throw new Error("Synthetic offline");
      return [task(`${owner}-remote`)];
    },
  };
  const cloud = new CloudRoutines(() => client as never);
  const list = cloud.route("listSchedules", async () =>
    owner === "A" ? previousLocal.promise : [task("B-local")],
  )!;
  const late = list();
  owner = "B";
  cloud.reset();
  await list();
  previousLocal.resolve([task("A-local")]);
  await late;
  fail = true;
  assert.deepEqual(
    ((await list()) as Routine[]).map((value) => value.id),
    ["B-local", "B-remote"],
  );
});

test("late remote saves and deletes cannot mutate the next account's fallback cache", async () => {
  for (const operation of ["saveSchedule", "deleteSchedule"] as const) {
    const pending = deferred<Routine>(),
      started = deferred<void>();
    let fail = false;
    const a = {
      call: async (method: string) => {
        if (method === "listSchedules") return [task("shared-task-id")];
        started.resolve();
        return pending.promise;
      },
    };
    const b = {
      call: async () => {
        if (fail) throw new Error("Synthetic B offline");
        return [task("shared-task-id")];
      },
    };
    let active = a;
    const cloud = new CloudRoutines(() => active as never);
    const list = cloud.route("listSchedules", async () => [])!;
    const mutate = cloud.route(operation, async () => task("local"))!;
    await list();
    const late =
      operation === "saveSchedule"
        ? mutate({ id: "shared-task-id", executionLocation: "remote" })
        : mutate("shared-task-id");
    const refused = assert.rejects(late, /Couldn’t connect/);
    await started.promise;
    active = b;
    cloud.reset();
    await list();
    pending.resolve(task("late-A-save"));
    await refused;
    fail = true;
    assert.deepEqual(
      ((await list()) as Routine[]).map((value) => value.id),
      ["shared-task-id"],
      operation,
    );
  }
});

test("ordinary save cannot migrate an existing task or mutate either execution host", async () => {
  const calls: string[] = [];
  const client = {
    call: async (method: string) => {
      calls.push(`remote:${method}`);
      return [];
    },
  };
  const cloud = new CloudRoutines(() => client as never);
  const source = task("A-local", "local");
  cloud.route("listSchedules", async () => [source])!;
  cloud.route("deleteSchedule", async () => {
    calls.push("local:delete");
  })!;
  const save = cloud.route("saveSchedule", async () => {
    calls.push("local:save");
    return source;
  })!;
  await assert.rejects(
    save({ id: source.id, executionLocation: "remote" }),
    /can’t be changed/,
  );
  assert.deepEqual(calls, []);
});

test("lazy account reset is observed before a late response writes any cache", async () => {
  const pending = deferred<Routine[]>();
  let owner = "A",
    previous = "A",
    fail = false;
  const a = { call: async () => pending.promise };
  const b = {
    call: async () => {
      if (fail) throw new Error("Synthetic B offline");
      return [task("B-remote")];
    },
  };
  const cloud = new CloudRoutines(() => {
    if (previous !== owner) {
      previous = owner;
      cloud.reset();
    }
    return (owner === "A" ? a : b) as never;
  });
  const list = cloud.route("listSchedules", async () => [])!;
  const late = list();
  await Promise.resolve();
  owner = "B";
  pending.resolve([task("A-remote")]);
  await late;
  await list();
  fail = true;
  assert.deepEqual(
    ((await list()) as Routine[]).map((value) => value.id),
    ["B-remote"],
  );
});
