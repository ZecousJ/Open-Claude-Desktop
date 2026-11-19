import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { LocalMemoryStore } from "../electron/memory/local-store";
import { MemoryService } from "../electron/memory/service";
import { projectScope } from "../electron/memory/types";
import { openPolicy } from "../shared/client-policy";
import type { MemoryPrefs, MemoryScopeRef } from "../shared/memory-api";
import { organizationUuid } from "../electron/official-ui/api/context";
import { memoryRoute } from "../electron/official-ui/api/memory";

test("official memory reads, switches and scoped reset use persistent engine data", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-official-memory-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const makeMemory = () =>
    new MemoryService({
      store: new LocalMemoryStore(root),
      policy: () => openPolicy,
      changed() {},
    });
  let memory = makeMemory();
  await memory.ready();
  const projectId = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const scopeOf = (ref: MemoryScopeRef) =>
    ref.kind === "global" ? ("global" as const) : projectScope(ref.projectId)!;
  let projectPresent = true;
  let synthesisResult: "fail" | "save" = "fail";
  let synthesisCalls = 0;
  const ctx = {
    account: () => ({ id: "memory-test" }),
    sessionIdentity: () => 1,
    snapshot: async () => ({ projects: projectPresent ? [{ id: projectId }] : [] }),
    async call(method: string, ...args: unknown[]) {
      if (method === "memoryStatus") return memory.status();
      if (method === "setMemoryPrefs")
        return memory.setPrefs(args[0] as Partial<MemoryPrefs>, args[1] as { disableOnly?: boolean } | undefined);
      if (method === "replaceMemoryControls")
        return memory.replaceControls(
          scopeOf(args[0] as MemoryScopeRef),
          args[1] as string[],
          args[2] as string,
        );
      if (method === "synthesizeMemory") {
        synthesisCalls++;
        if (synthesisResult === "fail") throw new Error("Test model unavailable");
        const scope = scopeOf(args[0] as MemoryScopeRef);
        assert.ok(args[1] instanceof AbortSignal);
        const previous = memory.docView(scope);
        await memory.saveDoc(scope, "Generated project notes", previous?.revision ?? 0);
        return memory.docView(scope);
      }
      if (method === "memoryControlsState") {
        const scope = scopeOf(args[0] as MemoryScopeRef);
        return {
          doc: memory.docView(scope),
          version: memory.controlsVersion(scope) ?? null,
        };
      }
      if (method === "memoryDoc")
        return memory.docView(scopeOf(args[0] as MemoryScopeRef));
      if (method === "resetMemory") {
        const scope = args[0] ? scopeOf(args[0] as MemoryScopeRef) : undefined;
        await memory.reset(scope);
        return {
          doc: memory.docView(scope ?? "global"),
          version: memory.controlsVersion(scope ?? "global") ?? null,
        };
      }
      throw Error(`Unexpected method: ${method}`);
    },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    void memoryRoute(req, res, url.pathname, url, ctx as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/organizations/${organizationUuid("memory-test")}/memory`;
  const post = (suffix: string, body: unknown) =>
    fetch(`${base}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await (await post("/settings", { enabled_saffron: true })).json())
      .enabled_saffron,
    true,
  );
  await memory.saveDoc("global", "Global notes", 0);
  await memory.addEdit("global", "Use concise replies");
  await memory.saveDoc(projectScope(projectId)!, "Project notes", 0);
  const row = await (await fetch(base)).json();
  assert.equal(row.memory, "Global notes");
  assert.deepEqual(row.controls, ["Use concise replies"]);
  assert.equal(
    (await (await fetch(`${base}?project_uuid=${projectId}`)).json()).memory,
    "Project notes",
  );
  assert.equal(
    (await fetch(`${base}?project_uuid=another-account`)).status,
    404,
  );
  assert.equal(
    (await post("/settings", { enabled_saffron_search: true })).status,
    200,
  );
  const putControls = (body: unknown) =>
    fetch(`${base}/controls`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const initial = await (await fetch(base)).json();
  assert.match(initial.controls_version, /^v1:/);
  assert.equal(
    (
      await putControls({
        controls: ["Metric units"],
        base_controls_version: initial.controls_version,
      })
    ).status,
    200,
  );
  assert.deepEqual((await (await fetch(base)).json()).controls, [
    "Metric units",
  ]);
  const stale = await putControls({
    controls: ["Stale"],
    base_controls_version: initial.controls_version,
  });
  assert.equal(stale.status, 409);
  assert.equal(
    (await stale.json()).error.details.error_code,
    "memory_changed_since_read",
  );
  const missing = await putControls({ controls: ["Missing version"] });
  assert.equal(missing.status, 409);
  const beforeFailure = memory.docView("global");
  assert.equal((await post("/synthesize", {})).status, 503);
  assert.deepEqual(memory.docView("global"), beforeFailure);
  assert.equal((await post("/synthesize", { project_uuid: "not-a-project" })).status, 400);
  assert.equal((await post(`/synthesize?project_uuid=${projectId}`, {})).status, 400);
  assert.equal((await post("/synthesize", { project_uuid: projectId, model: "untrusted" })).status, 400);
  assert.equal(synthesisCalls, 1);
  synthesisResult = "save";
  assert.equal((await post("/synthesize", { project_uuid: projectId })).status, 200);
  assert.equal(synthesisCalls, 2);
  assert.equal(memory.docView(projectScope(projectId)!)?.content, "Generated project notes");
  assert.deepEqual(memory.docView("global"), beforeFailure);
  assert.equal(
    (
      await putControls({
        controls: ["x"],
        project_uuid: "other-account",
        base_controls_version: initial.controls_version,
      })
    ).status,
    404,
  );
  memory.close();
  memory = makeMemory();
  await memory.ready();
  assert.deepEqual(memory.status().prefs, {
    generate: true,
    searchChats: true,
  });
  assert.equal(
    (await post("/settings", { enabled_melange: true })).status,
    400,
  );
  assert.equal((await post("/settings", { clear_data: true })).status, 400);
  assert.equal((await post("/reset", { project_id: projectId })).status, 400);
  assert.equal(memory.docView("global")!.content, "Global notes");
  assert.equal((await post("/reset", { project_uuid: projectId })).status, 200);
  assert.equal(memory.docView(projectScope(projectId)!), null);
  const resetToken = (
    await (await fetch(`${base}?project_uuid=${projectId}`)).json()
  ).controls_version;
  const resetConflict = await putControls({
    controls: ["Stale project"],
    project_uuid: projectId,
    base_controls_version: "v1:0:0:0",
  });
  assert.equal(resetConflict.status, 409);
  assert.equal(
    (await resetConflict.json()).error.details.error_code,
    "memory_reset_since_read",
  );
  assert.notEqual(resetToken, "v1:0:0:0");

  projectPresent = false;
  const deletedProject = await putControls({
    controls: ["Stale project"],
    project_uuid: projectId,
    base_controls_version: resetToken,
  });
  assert.equal(deletedProject.status, 404);
  assert.equal((await deletedProject.json()).error.details.error_code, "memory_deleted_since_read");
  assert.equal((await fetch(`${base}?project_uuid=${projectId}`)).status, 404);
  assert.equal(memory.docView(projectScope(projectId)!), null);

  assert.equal(memory.docView("global")!.content, "Global notes");
  assert.equal(
    (
      await post("/settings", {
        enabled_melange: false,
        enabled_saffron: false,
        clear_data: true,
      })
    ).status,
    200,
  );
  assert.equal(memory.docView("global"), null);
  assert.deepEqual(memory.status().prefs, {
    generate: false,
    searchChats: true,
  });
  memory.close();
});

test("the Web read boundary reads scoped documents but cannot clear memory", async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    void memoryRoute(req, res, url.pathname, url, {
      account: () => ({ id: "memory-test" }),
      sessionIdentity: () => 1,
      readOnly: true,
      call: async () => {
        calls++;
        return { doc: null, version: "v1:0:0:0" };
      },
    } as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/organizations/${organizationUuid("memory-test")}/memory`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal(
    (await fetch(`${base}/reset`, { method: "POST", body: "{}" })).status,
    501,
  );
  assert.equal(
    (
      await fetch(`${base}/settings`, {
        method: "POST",
        body: '{"enabled_saffron":false}',
      })
    ).status,
    501,
  );
  assert.equal(calls, 1);
});
