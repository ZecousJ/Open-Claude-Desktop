import test from "node:test";
import assert from "node:assert/strict";
import { requestCodeHelperCloud, registerCodeHelperCloud } from "../../electron/engine/code-helper-cloud";

const input = { title: "Cloud task", brief: "A concrete cloud task", repository: "owner/repo", environment: "Fixture", threadId: "thread", turnId: "turn", toolCallId: "tool" };
function fixture() {
  const parent: any = { id: "parent", mode: "code", cwd: "/tmp", model: "model", providerId: "p", threadId: "thread", turns: [{ id: "turn", status: "inProgress" }] };
  const calls: any[] = [];
  let approve = true, fail = false, ready = true, activated: (() => void) | undefined;
  const store: any = { conversations: [parent], commitLocalCodeHistory(c: any, patch: any, _add: any, current: () => boolean) {
    assert.equal(current(), true); Object.assign(c, structuredClone(patch));
  } };
  const environment = { id: "default", name: "Fixture", network: "trusted", allowedDomains: [], includeDefaultDomains: true, variables: "", setupScript: "", updatedAt: 1 };
  const cloud = { available: () => ready, listCloudEnvironments: async () => [structuredClone(environment)],
    startSideSession: async (args: any) => { calls.push(args); if (fail) throw Error("unknown"); return "session_0123456789abcdef0123456789abcdef"; } };
  const ctx: any = { store, activeAccount: { id: "owner" }, accountActivationIdentity: 1, accountRetiring: false,
    officialCodeHelperCloud: () => cloud, allowedFolder() {},
    engine: { changed() {}, requestAppApproval: async () => ({ action: approve ? "accept" : "decline" }) },
    onAccountActivated(cb: () => void) { activated = cb; return () => {}; },
    onAccountDeactivating() { return () => {}; } };
  return { ctx, parent, calls, environment, setApproval: (v: boolean) => { approve = v; }, setFail: (v: boolean) => { fail = v; }, setReady: (v: boolean) => { ready = v; }, activate: () => activated?.() };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("cloud start requires approval and retries one durable identity after an unknown response", async () => {
  const f = fixture();
  f.setApproval(false);
  await assert.rejects(requestCodeHelperCloud(f.ctx, f.parent, input, () => true), /not approved/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.parent.codeCloudHelperStarts, undefined);
  f.setApproval(true); f.setFail(true);
  const { taskId } = await requestCodeHelperCloud(f.ctx, f.parent, input, () => true);
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.parent.codeCloudHelperStarts[0].state, "pending");
  assert.equal(f.parent.codeCloudHelperStarts[0].taskId, taskId);
  const first = structuredClone(f.calls[0]);
  f.setFail(false);
  registerCodeHelperCloud(f.ctx); f.activate(); await tick();
  assert.deepEqual(f.calls[1], first);
  assert.equal(f.parent.codeCloudHelperStarts[0].state, "started");
  assert.equal(f.parent.cloudSpawnedTasks[0].taskId, taskId);
  assert.equal(f.parent.cloudSpawnedTasks[0].messageUuid, first.requestId);
  assert.deepEqual(await requestCodeHelperCloud(f.ctx, f.parent, input, () => true), { taskId });
  assert.equal(f.calls.length, 2);
});
test("an aborted approval cannot reserve or start a cloud task", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.ctx.engine.requestAppApproval = async (_id: string, _params: unknown, signal: AbortSignal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return { action: "accept" };
  };
  await assert.rejects(requestCodeHelperCloud(f.ctx, f.parent, { ...input, signal: controller.signal }, () => true), /changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.parent.codeCloudHelperStarts, undefined);
});

test("recovery never sends an approved brief to an edited environment", async () => {
  const f = fixture(); f.setFail(true);
  await requestCodeHelperCloud(f.ctx, f.parent, input, () => true); await tick();
  f.environment.updatedAt++; f.setFail(false);
  registerCodeHelperCloud(f.ctx); f.activate(); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.parent.codeCloudHelperStarts[0].state, "pending");
});
test("approval labels cannot contain control or bidirectional characters", async () => {
  const f = fixture(); f.environment.name = "Fix\u202eture";
  let message = "";
  f.ctx.engine.requestAppApproval = async (_id: string, params: { message: string }) => { message = params.message; return { action: "decline" }; };
  await assert.rejects(requestCodeHelperCloud(f.ctx, f.parent, { ...input, title: "Cloud\u202etask", environment: "default" }, () => true));
  assert.doesNotMatch(message, /[\u202a-\u202e]/);
  assert.match(message, /Cloudtask/);
});

test("recovery waits for cloud readiness and sends only once on this activation", async () => {
  const f = fixture(); f.setFail(true);
  await requestCodeHelperCloud(f.ctx, f.parent, input, () => true); await tick();
  f.setReady(false); registerCodeHelperCloud(f.ctx); f.activate();
  assert.equal(f.calls.length, 1);
  f.setReady(true); await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.calls.length, 2);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(f.calls.length, 2);
});
