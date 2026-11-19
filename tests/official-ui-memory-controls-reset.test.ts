import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const assets = "build/official-ui/ui/assets/v1";
const shared = "shared-0-BgsOqC85.js";

const apiErrors = fs.readFileSync(
  path.join(assets, "shared-l-p-m-w-0-C_nAiu5o.js"),
  "utf8",
);
const errorCode = apiErrors.match(/  Qd = (\(e\) => \{[\s\S]+?\n  \}),/);
assert.ok(errorCode, "original API error-code extractor");
const R0 = new Function("_3", `return (${errorCode[1]});`)(
  class ApiError extends Error {},
);

const initial = { controls: ["Original"], controls_version: "v1:0:0:1" };
const concurrent = {
  controls: ["Original", "Other device"],
  controls_version: "v1:0:0:2",
};
const draft = {
  controls: [...initial.controls, "Draft"],
  editedFrom: initial.controls,
  editedFromVersion: initial.controls_version,
};

function memorySave(
  cacheAtSave: typeof initial,
  readAfterConflict: typeof initial,
  putConflict?: string,
) {
  const source = fs.readFileSync(path.join(assets, shared), "utf8");
  const start = source.indexOf('var VW = "memory_changed_since_read"');
  const end = source.indexOf("function _L()", start);
  assert.ok(start >= 0 && end > start);
  const writes: {
    controls: string[];
    project_uuid: string;
    base_controls_version: string;
  }[] = [];
  const notices: string[] = [];
  let cache = cacheAtSave;
  const factory = new Function(
    "hooks",
    `
    const { J9, J0, J1, J2, J3, J4, J5, K0, K1, K2, K3, K4, K5, AG, a4, _L,
      bek, pT, _V, vy, W6E, EI, gf, Ha, go, R0 } = hooks;
    ${source.slice(start, end)}
    return KuA({ projectUuid: "project" }).updateMemoryControls;
  `,
  );
  const save = factory({
    J9: () => [],
    J0: () => true,
    J1: () => true,
    J2: () => true,
    J3: () => true,
    J4: () => true,
    J5: () => true,
    K0: (...args: unknown[]) => args.at(-1),
    K1: (...args: unknown[]) => args.at(-1),
    K2: (...args: unknown[]) => args.at(-1),
    K3: (...args: unknown[]) => args.at(-1),
    K4: (...args: unknown[]) => args.at(-1),
    K5: (...args: unknown[]) => args.at(-1),
    AG: () => ({}),
    a4: () => ({
      account: { uuid: "account" },
      activeOrganization: { uuid: "org" },
    }),
    _L: () => true,
    bek: () => ({
      addError: (message: string) => notices.push(message),
      addSuccess: (message: string) => notices.push(message),
      addWarning: (message: string) => notices.push(message),
    }),
    pT: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
    _V: () => ({
      getQueryData: () => cache,
      invalidateQueries: () => {},
      refetchQueries: async () => {
        cache = readAfterConflict;
      },
    }),
    vy: () => false,
    W6E: () => ({}),
    EI: () => [0, () => {}],
    gf: "memory",
    Ha: () => ({
      mutateAsync: async (request: (typeof writes)[number]) => {
        writes.push(request);
        if (writes.length === 1 && putConflict)
          throw Object.assign(new Error(putConflict), { code: putConflict });
      },
    }),
    go: () => "current session",
    R0,
  });
  return {
    writes,
    notices,
    save: () =>
      new Promise<"saved" | "rejected">((resolve) =>
        save(draft, {
          onSuccess: () => resolve("saved"),
          onError: () => resolve("rejected"),
        }),
      ),
  };
}

for (const [label, version] of [
  ["project reset", "v1:0:1:3"],
  ["account reset", "v1:1:0:0"],
]) {
  const reset = { controls: [], controls_version: version };
  test(`the ${label} already in the cache rejects the old draft before PUT`, async () => {
    const memory = memorySave(reset, reset);
    assert.equal(await memory.save(), "rejected");
    assert.deepEqual(memory.writes, []);
    assert.match(memory.notices[0], /change wasn’t saved/);
  });
  test(`the ${label} after a revision conflict rejects the old draft before retry`, async () => {
    const memory = memorySave(initial, reset, "memory_changed_since_read");
    assert.equal(await memory.save(), "rejected");
    assert.deepEqual(memory.writes, [
      {
        controls: draft.controls,
        project_uuid: "project",
        base_controls_version: initial.controls_version,
      },
    ]);
    assert.match(memory.notices[0], /change wasn’t saved/);
  });
}

test("a revision conflict in the same lineage still merges the draft", async () => {
  const memory = memorySave(initial, concurrent, "memory_changed_since_read");
  assert.equal(await memory.save(), "saved");
  assert.deepEqual(memory.writes.at(-1), {
    controls: [...concurrent.controls, "Draft"],
    project_uuid: "project",
    base_controls_version: concurrent.controls_version,
  });
  assert.deepEqual(memory.notices, ["Memory updated"]);
});
