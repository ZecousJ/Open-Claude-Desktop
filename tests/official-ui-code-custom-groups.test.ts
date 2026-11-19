import assert from "node:assert/strict";
import test from "node:test";
import { organizationUuid } from "../electron/official-ui/api/context";
import { registerCodeCustomGroups } from "../electron/official-ui/native/code-custom-groups";
import type { NativeHost } from "../electron/official-ui/native/host";

const first = "local_11111111-1111-4111-8111-111111111111";
const second = "local_22222222-2222-4222-8222-222222222222";
const planning = { id: "planning", name: "Planning" };
const review = { id: "review", name: "Review" };

function payload(owner: string) {
  return {
    accountUuid: owner,
    orgUuid: organizationUuid(owner),
    groups: [planning, review],
    assignments: { [first]: planning.id, [second]: review.id },
  };
}

function fixture() {
  let owner = "alice";
  let activation = {};
  let active = true;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const host = {
    ctx: {
      account: () => ({ id: owner }),
      sessionIdentity: () => activation,
      isCurrent: () => active,
    },
    on: (name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
  };
  const groups = registerCodeCustomGroups(host as unknown as NativeHost);
  const set = handlers.get("LocalSessions.setCustomGroups");
  assert.ok(set);
  return {
    ...groups,
    set,
    activate(next: string) {
      owner = next;
      activation = {};
      active = true;
    },
    retire() {
      active = false;
    },
  };
}

test("the renderer's Code group snapshots replace the native group and session mapping", () => {
  const groups = fixture();
  assert.equal(groups.listCustomGroups(), undefined);
  assert.equal(groups.getSessionCustomGroup(first), undefined);

  const original = payload("alice");
  assert.equal(groups.set(original), undefined);
  assert.deepEqual(groups.getSessionCustomGroup(first), planning);
  assert.deepEqual(groups.getSessionCustomGroup(second), review);

  const renamed = { ...planning, name: "Planning tomorrow" };
  groups.set({
    ...original,
    groups: [review, renamed],
    assignments: { [first]: review.id },
  });
  assert.deepEqual(groups.listCustomGroups(), [
    { ...review, order: 0, sessionCount: 1 },
    { ...renamed, order: 1, sessionCount: 0 },
  ]);
  assert.deepEqual(groups.getSessionCustomGroup(first), review);
  assert.equal(groups.getSessionCustomGroup(second), null);

  groups.set({ ...original, groups: [], assignments: {} });
  assert.deepEqual(groups.listCustomGroups(), []);
  assert.equal(groups.getSessionCustomGroup(first), null);
});

test("a Code group snapshot belongs to its account, organization, and activation", () => {
  const groups = fixture();
  const alice = payload("alice");
  const bob = payload("bob");
  groups.set(alice);
  assert.throws(() => groups.set({ ...alice, assignments: { [first]: 123 } }));
  groups.set({ ...alice, orgUuid: bob.orgUuid, groups: [], assignments: {} });
  assert.deepEqual(groups.getSessionCustomGroup(first), planning);

  groups.retire();
  assert.equal(groups.getSessionCustomGroup(first), undefined);
  groups.activate("bob");
  groups.set(alice);
  assert.equal(groups.listCustomGroups(), undefined);
  groups.set(bob);
  assert.deepEqual(groups.getSessionCustomGroup(second), review);

  groups.activate("alice");
  assert.equal(groups.listCustomGroups(), undefined);
  groups.set(alice);
  groups.activate("alice");
  assert.equal(groups.getSessionCustomGroup(first), undefined);
});
