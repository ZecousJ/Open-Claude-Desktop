import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-library-read-"));
  const skills = [
    {
      name: "Zebra",
      description: "Calendar planning",
      scope: "user",
      enabled: true,
    },
    {
      name: "Alpha",
      description: "Research notes",
      scope: "user",
      enabled: false,
    },
    {
      name: "Team",
      description: "Shared research guide",
      scope: "admin",
      enabled: true,
    },
  ].map((skill, index) => {
    const file = path.join(root, String(index), "SKILL.md");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(
      file,
      `---\nname: ${skill.name}\n---\n${skill.description}\n`,
    );
    fs.utimesSync(file, new Date(1000 * index), new Date(1000 * index));
    return { ...skill, path: file };
  });
  let owner: string | undefined = "owner",
    identity = 1;
  let failure = false,
    switchAccount = false,
    switchSession = false;
  const calls: string[] = [];
  const run = createRunnerOfficialAdapter(
    {
      account: () =>
        owner
          ? { id: owner, email: "owner@example.invalid", name: "Owner" }
          : undefined,
      settings: () => ({}),
      sessionIdentity: () => identity,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method) => {
      calls.push(method);
      assert.equal(
        method,
        "listSkills",
        "library reads must not dispatch mutations",
      );
      if (failure) throw Error("skill service offline");
      if (switchAccount) owner = "other";
      if (switchSession) identity++;
      return [{ skills }];
    },
    root,
    { modes: ["chat"] },
  );
  const base = `/api/organizations/${organizationUuid("owner")}/library/mine`;
  return {
    root,
    skills,
    calls,
    run,
    base,
    query: (query = "?kind=skill&limit=1000") =>
      run({ method: "GET", path: base + query }),
    fail() {
      failure = true;
    },
    switchAccount() {
      switchAccount = true;
    },
    switchSession() {
      switchSession = true;
    },
    signOut() {
      owner = undefined;
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const json = (reply: { body: Uint8Array }) =>
  JSON.parse(Buffer.from(reply.body).toString());

test("Web skill library returns real stable skill identities and readonly capabilities", async () => {
  const f = fixture();
  try {
    const response = await f.query();
    assert.equal(response.status, 200);
    const first = json(response);
    assert.deepEqual(first.items.map((item: any) => item.name).sort(), [
      "Alpha",
      "Team",
      "Zebra",
    ]);
    assert.equal(first.next_cursor, null);
    for (const item of first.items) {
      assert.match(item.id, /^skill_[a-f0-9]{24}$/);
      assert.equal(item.skill.skill_id, item.id);
      assert.equal(
        item.skill.partition_by,
        item.name === "Team" ? "organization" : "account",
      );
      assert.equal(item.viewer.added, true);
      assert.equal(item.viewer.installed.claudex_read_only, true);
      assert.equal(item.viewer.installed.can_edit, false);
      assert.equal(item.viewer.installed.can_remove, false);
      assert.equal(item.viewer.installed.can_toggle, false);
      assert.equal(item.viewer.installed.enabled, item.name !== "Alpha");
    }
    assert.deepEqual(
      json(await f.query()).items,
      first.items,
      "repeat read must retain identity/order",
    );
    assert.equal(
      Buffer.from(response.body).toString().includes(f.root),
      false,
      "no local skill paths in wire data",
    );
  } finally {
    f.close();
  }
});

test("Web skill library query searches names/descriptions and returns a real empty match", async () => {
  const f = fixture();
  try {
    for (const [q, names] of [
      ["ALPHA", ["Alpha"]],
      ["research", ["Alpha", "Team"]],
      ["not-present", []],
    ] as const) {
      const response = await f.query(`?kind=skill&q=${q}&limit=1000`);
      assert.equal(response.status, 200);
      assert.deepEqual(
        json(response)
          .items.map((item: any) => item.name)
          .sort(),
        names,
      );
    }
  } finally {
    f.close();
  }
});

test("Web skill library cursor pages are bounded, nonoverlapping and exhaustive", async () => {
  const f = fixture();
  try {
    const full = await f.query();
    assert.equal(full.status, 200);
    const all = json(full).items.map((item: any) => item.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const response = await f.query(
        `?kind=skill&limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      assert.equal(response.status, 200);
      const data = json(response);
      assert.equal(data.items.length, 1);
      seen.push(data.items[0].id);
      if (data.next_cursor === null) break;
      assert.equal(typeof data.next_cursor, "string");
      assert.notEqual(data.next_cursor, cursor);
      cursor = data.next_cursor;
    }
    assert.deepEqual(seen, all);
    assert.equal(new Set(seen).size, all.length);
  } finally {
    f.close();
  }
});

test("Web skill library rejects unsupported kind/filter and malformed paging instead of fake success", async () => {
  const f = fixture();
  try {
    for (const query of [
      "?kind=unknown",
      "?kind=skill&sort=unknown",
      "?kind=skill&source=unknown",
      "?kind=skill&marketplace_id=unknown",
      "?kind=skill&category=unknown",
      "?kind=skill&limit=0",
      "?kind=skill&limit=-1",
      "?kind=skill&limit=1.5",
      "?kind=skill&limit=garbage",
      "?kind=skill&cursor=garbage",
    ]) {
      const response = await f.query(query);
      assert.ok(
        response.status >= 400,
        `${query}: must explicitly fail, got ${response.status}`,
      );
      assert.equal(
        Array.isArray(json(response).items),
        false,
        `${query}: not an empty successful library`,
      );
    }
  } finally {
    f.close();
  }
});

test("Web skill library rejects foreign org and signed-out access before reading skills", async () => {
  const f = fixture();
  try {
    assert.equal(
      (
        await f.run({
          method: "GET",
          path:
            f.base.replace(
              organizationUuid("owner"),
              organizationUuid("other"),
            ) + "?kind=skill",
        })
      ).status,
      404,
    );
    assert.deepEqual(f.calls, []);
    f.signOut();
    assert.equal((await f.query()).status, 401);
    assert.deepEqual(f.calls, []);
  } finally {
    f.close();
  }
});

test("Web skill library service failure never becomes an empty successful library", async () => {
  const f = fixture();
  try {
    f.fail();
    const response = await f.query();
    assert.equal(response.status, 500);
    assert.equal(Array.isArray(json(response).items), false);
  } finally {
    f.close();
  }
});

for (const change of ["switchAccount", "switchSession"] as const) {
  test(`Web skill library discards pending data after ${change}`, async () => {
    const f = fixture();
    try {
      f[change]();
      const response = await f.query();
      assert.equal(response.status, 500);
      assert.equal(
        Buffer.from(response.body).toString().includes("Zebra"),
        false,
      );
    } finally {
      f.close();
    }
  });
}

test("Web skill library supported sort/source filters retain actual ownership", async () => {
  const f = fixture();
  try {
    for (const [query, expected] of [
      ["sort=name", ["Alpha", "Team", "Zebra"]],
      ["sort=recent", ["Team", "Alpha", "Zebra"]],
      ["source=personal&sort=name", ["Alpha", "Zebra"]],
      ["source=organization", ["Team"]],
    ] as const) {
      const response = await f.query(`?kind=skill&${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(
        json(response).items.map((item: any) => item.name),
        expected,
      );
    }
  } finally {
    f.close();
  }
});

test("Web skill library cursor rejects changed filters and changed inventory", async () => {
  const f = fixture();
  try {
    const first = await f.query("?kind=skill&limit=1");
    assert.equal(first.status, 200);
    const cursor = encodeURIComponent(json(first).next_cursor);
    for (const query of ["q=research", "sort=name", "source=personal"]) {
      assert.equal(
        (await f.query(`?kind=skill&limit=1&cursor=${cursor}&${query}`)).status,
        400,
      );
    }
    f.skills[0].name = "Changed skill";
    fs.utimesSync(f.skills[0].path, new Date(9000), new Date(9000));
    assert.equal(
      (await f.query(`?kind=skill&limit=1&cursor=${cursor}`)).status,
      400,
    );
  } finally {
    f.close();
  }
});

test("Web skill library rejects unsupported ranking and duplicate single-valued parameters", async () => {
  const f = fixture();
  try {
    for (const query of [
      "?kind=skill&q=a&q=b",
      "?kind=skill&limit=1&limit=2",
      "?kind=skill&sort=installs",
      "?kind=skill&source=shared",
      "?kind=skill&limit=1001",
    ]) {
      const response = await f.query(query);
      assert.ok(
        response.status >= 400,
        `${query}: should not silently return an incomplete/ambiguous library`,
      );
    }
  } finally {
    f.close();
  }
});
