import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement as h } from "react";
import type { AppContext as BackendContext } from "../../electron/app/app-context";
import { defaultSettings } from "../../electron/store/store";
import { routineExecutionMetadata } from "../../electron/routines/routine-execution-metadata";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import type { CloudCalls } from "../../electron/cloud/cloud-router";
import type { Routine } from "../../shared/routines";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { RoutinesPage } from "../../src/collections/routines/RoutinesPage";
import { RoutineCard } from "../../src/collections/routines/RoutineCard";
import {
  offeredRoutineFilters,
  defaultRoutineFilter,
  visibleRoutines,
} from "../../src/collections/routines/routine-list";
import { routineDom } from "../support/routine-dom";

const attention = { unread: 0, awaiting: 0, failed: 0, conversationIds: [] };
const task = (id: string, patch: Partial<Routine> = {}): Routine => ({
  id,
  name: id,
  mode: "code",
  prompt: "Review the changes",
  enabled: true,
  providerId: "p",
  model: "m",
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: Date.now() + 86400000,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const metadata = (
  host: NonNullable<Routine["listMetadata"]>["host"],
  patch: Partial<NonNullable<Routine["listMetadata"]>> = {},
) => ({
  source: "code" as const,
  host,
  attention,
  ...patch,
});

// Real owner data, including the existing persisted device link, feeds the public projection.
test("scheduler metadata preserves stable local identity and explicit SSH/cloud provenance", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b30-device-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { dataRoot: root, services: {} } as BackendContext;
  const first = routineExecutionMetadata(ctx, task("local"), "local");
  const second = routineExecutionMetadata(ctx, task("local"), "local");
  assert.ok(first.device?.id);
  assert.equal(
    first.device.id,
    fs.readFileSync(path.join(root, "device-link-id"), "utf8"),
  );
  assert.deepEqual(first, second);
  assert.equal(first.device.connectivity, "connected");
  assert.equal(first.provenance?.deviceId, first.device.id);
  const cloud = routineExecutionMetadata(ctx, task("cloud"), "remote");
  assert.equal(cloud.host, "cloud");
  assert.equal(cloud.device, undefined);
  assert.deepEqual(cloud.provenance, { backend: "remote" });
  let status = "ready";
  const ssh = {
    hosts: { get: () => ({ label: "Build Mac" }) },
    existing: () => ({ status: { state: status } }),
  };
  const sshContext = { services: { ssh } } as unknown as BackendContext;
  const remoteTask = task("ssh", {
    environment: { kind: "ssh", hostId: "real-host-1" },
  });
  assert.deepEqual(
    routineExecutionMetadata(sshContext, remoteTask, "local").device,
    { id: "real-host-1", name: "Build Mac", connectivity: "connected" },
  );
  status = "connecting";
  assert.equal(
    routineExecutionMetadata(sshContext, remoteTask, "local").device
      ?.connectivity,
    "unknown",
  );
});

test("actual cloud adapter preserves identity on partial failure but clears stale connectivity and cloud computer claims", async () => {
  let fail = false;
  const localTask = task("local", {
    listMetadata: metadata("this-computer", {
      device: {
        id: "stable-device-1",
        name: "Office Mac",
        connectivity: "connected",
      },
      provenance: { backend: "local", deviceId: "stable-device-1" },
    }),
  });
  const client = {
    call: async () => ({
      tasks: [localTask],
      sources: [{ source: "remote", status: "ready" }],
    }),
  } as unknown as CloudCalls;
  const router = new CloudRoutines(() => client);
  const query = router.route("querySchedules", async () => {
    if (fail) throw new Error("temporarily unavailable");
    return {
      tasks: [localTask],
      sources: [{ source: "local", status: "ready" }],
    };
  })!;
  const fresh = await query();
  assert.equal(fresh.tasks[0].listMetadata.device.connectivity, "connected");
  assert.equal(fresh.tasks[1].listMetadata.device, undefined);
  assert.equal(fresh.tasks[1].listMetadata.host, "cloud");
  fail = true;
  const stale = await query();
  assert.equal(stale.tasks[0].listMetadata.device.id, "stable-device-1");
  assert.equal(stale.tasks[0].listMetadata.device.connectivity, "unknown");
  assert.equal(stale.sources[0].status, "error");
});

test("cloud source capabilities come only from successful backend reports and honor a requested backend", async () => {
  let remoteReady = true;
  const local = async () => ({
    remote: false,
    email: false,
    slack: false,
    sources: ["chat"],
  });
  const client = {
    call: async () => {
      if (!remoteReady) throw new Error("offline");
      return {
        remote: false,
        email: false,
        slack: false,
        sources: ["code", "chat"],
      };
    },
  } as unknown as CloudCalls;
  const router = new CloudRoutines(() => client);
  const capabilities = router.route("routineCapabilities", local)!;
  assert.deepEqual((await capabilities()).sources, ["chat", "code"]);
  assert.deepEqual((await capabilities("local")).sources, ["chat"]);
  assert.deepEqual((await capabilities("remote")).sources, ["code", "chat"]);
  remoteReady = false;
  assert.deepEqual((await capabilities()).sources, ["chat"]);
  await assert.rejects(capabilities("remote"), /offline/);
});

test("filter offerings combine supported capabilities and real data without inventing computer categories", () => {
  const offered = offeredRoutineFilters([], {
    sources: ["chat", "code"],
    cloud: true,
    thisComputer: true,
  });
  assert.deepEqual(offered.sources, ["all", "chat", "code"]);
  assert.deepEqual(offered.hosts, ["all", "cloud", "this-computer"]);
  assert.deepEqual(offered.statuses, ["all", "active", "paused"]);
  const held = task("held", {
    connectionHold: { service: "offline" },
    listMetadata: metadata("another-computer"),
  });
  const disabled = task("disabled", {
    enabled: false,
    endedReason: "auto_disabled_repo_access",
  });
  assert.deepEqual(offeredRoutineFilters([held, disabled]).statuses, [
    "all",
    "active",
    "paused",
    "auto-disabled",
    "on-hold",
  ]);
  assert.equal(
    visibleRoutines(
      [held],
      "",
      { ...defaultRoutineFilter, status: "active" },
      "next",
    ).length,
    0,
  );
  assert.equal(
    visibleRoutines(
      [held],
      "",
      { ...defaultRoutineFilter, runsOn: "another-computer" },
      "next",
    ).length,
    1,
  );
});

test("rendered cards expose known/unknown host identity and connectivity without attributing a computer to cloud Chat", async () => {
  const env = await routineDom();
  const render = (routine: Routine, host = desktopHost) =>
    env.render(
      h(
        HostContext.Provider,
        { value: host },
        h(RoutineCard, {
          routine,
          off: false,
          starting: false,
          menuOpen: false,
          onEdit() {},
          onMenu() {},
        }),
      ),
    );
  try {
    await render(
      task("local", {
        listMetadata: metadata("this-computer", {
          device: {
            id: "stable",
            name: "Office Mac",
            connectivity: "connected",
          },
        }),
      }),
    );
    let badge = env.document.querySelector(".routine-computer")!;
    assert.equal(badge.textContent, "This computer");
    assert.equal(
      badge.getAttribute("aria-label"),
      "Runs on Office Mac · Connected",
    );
    assert.equal(
      badge
        .querySelector("[data-connectivity]")
        ?.getAttribute("data-connectivity"),
      "connected",
    );
    await render(
      task("other", {
        listMetadata: metadata("another-computer", {
          device: { id: "other", name: "Lab Mac", connectivity: "offline" },
        }),
      }),
    );
    badge = env.document.querySelector(".routine-computer")!;
    assert.equal(badge.textContent, "Lab Mac");
    assert.equal(
      badge.getAttribute("title"),
      "Runs on Lab Mac · Asleep or app closed",
    );
    assert.ok(badge.querySelector("[data-no-translate]"));
    await render(task("unknown", { executionLocation: "local" }));
    assert.equal(
      env.document.querySelector(".routine-computer")?.textContent,
      "Unknown computer",
    );
    assert.equal(env.document.querySelector("[data-connectivity]"), null);
    await render(
      task("cloud", {
        mode: "cowork",
        executionLocation: "remote",
        listMetadata: metadata("cloud", { source: "chat" }),
      }),
      webHost,
    );
    assert.equal(env.document.querySelector(".routine-computer"), null);
    assert.ok(
      env.document.querySelector('[aria-label="More options for cloud"]'),
    );
  } finally {
    await env.clean();
  }
});

test("real filter menu selects host and held states, then Clear filters restores the complete list", async () => {
  const rows = [
    task("Office task", { listMetadata: metadata("this-computer") }),
    task("Lab task", {
      mode: "cowork",
      connectionHold: { service: "offline" },
      listMetadata: metadata("another-computer", { source: "chat" }),
    }),
  ];
  const env = await routineDom({
    querySchedules: async () => ({
      tasks: rows,
      sources: [{ source: "local", status: "ready" }],
    }),
  });
  const previous = new Map(
    ["innerWidth", "innerHeight"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 900,
  });
  const choose = async (label: string) => {
    await env.click('[aria-label="Filter scheduled tasks"]');
    const choice = [
      ...env.document.querySelectorAll('[role="menuitemradio"]'),
    ].find((item) => item.textContent?.trim() === label)!;
    assert.ok(choice, label);
    await env.event(choice, "click");
  };
  try {
    await env.render(
      h(RoutinesPage, {
        settings: defaultSettings,
        onOpenConversation() {},
        onChooseFolder: async () => null,
        onConfirmDelete() {},
        onError(error) {
          throw error;
        },
      }),
    );
    await choose("Another computer");
    assert.equal(
      env.document.querySelectorAll(".routine-grid .routine-item").length,
      1,
    );
    assert.equal(
      env.document.querySelector(".routine-card-name")?.textContent,
      "Lab task",
    );
    await choose("Paused");
    assert.ok(env.document.querySelector(".routines-none"));
    await env.click(".routines-clear");
    assert.equal(
      env.document.querySelectorAll(".routine-grid .routine-item").length,
      2,
    );
    // The Schedule group (Recurring / One-time) is in the menu and filters.
    await choose("One-time");
    assert.ok(env.document.querySelector(".routines-none"));
    await env.click(".routines-clear");
    await choose("Recurring");
    assert.equal(
      env.document.querySelectorAll(".routine-grid .routine-item").length,
      2,
    );
    await choose("On hold");
    assert.equal(
      env.document.querySelectorAll(".routine-grid .routine-item").length,
      1,
    );
    assert.equal(
      env.document.querySelector(".routine-card-name")?.textContent,
      "Lab task",
    );
  } finally {
    await env.clean();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
