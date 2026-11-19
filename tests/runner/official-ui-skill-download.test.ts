import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import JSZip from "jszip";
import { skillDownloadRoute } from "../../electron/official-ui/api/skill-download";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { skillImportLimits } from "../../shared/skill-import";
import {
  officialResponseChunkBytes,
  officialResponseChunkPath,
} from "../../shared/official-response-transfer";
import {
  isOfficialUiLargeResponse,
  officialUiReadMaxBytes,
  type OfficialUiWireRequest,
  type OfficialUiWireResponse,
} from "../../shared/official-ui-web";
import { collectOfficialResponse } from "../../shared/web-client/official-response";
import { encodeWireValue } from "../../shared/web-wire";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { useElectronShim } from "./runner-core-support.test";

useElectronShim();
const { officialUiRead } = await import("../../runner/src/official-ui-read");
const { newSession, run } =
  await import("../../runner/src/dispatcher-sessions");
const { registerSkillHandlers } = await import("../../electron/ipc/skills");

const account = { id: "owner", name: "Owner", email: "owner@example.invalid" };
const organization = organizationUuid(account.id);
const archivePath = (org = organization) =>
  `/api/organizations/${org}/skills/download-dot-skill-file`;
const markdown = Buffer.from(
  "---\r\nname: research\r\ndescription: Sample\r\n---\r\nOriginal text\r\n",
);
const note = Buffer.from("完整文本😀\n");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEpEDAABoAD1UCKP3AAAAAElFTkSuQmCC",
  "base64",
);
const skillId = (file: string) =>
  "skill_" + createHash("sha256").update(file).digest("hex").slice(0, 24);

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-skill-zip-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "profile");
  const folder = path.join(root, "codex-home", "skills", "research");
  const put = (relative: string, data: Buffer | string) => {
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  };
  const skill = { path: put("SKILL.md", markdown), name: "research" };
  put("notes/中文.txt", note);
  put("assets/image.png", png);
  const id = skillId(skill.path);
  const inventory = [{ skills: [skill] }];
  let activation = {};
  let owner: typeof account | undefined = account;
  let stateRoot = root;
  let active = true;
  let afterList: (() => void) | undefined;
  let calls = 0;
  const identity = () => activation;
  const list = async () => {
    calls++;
    afterList?.();
    return inventory;
  };
  const query = (trigger = "view") =>
    `skill_id=${id}&include_blocked=true&trigger=${trigger}`;
  const route = async (
    search = query(),
    org = organization,
    method = "GET",
  ) => {
    const pathname = archivePath(org);
    let status = 0;
    let headers: Record<string, string> = {};
    let body: Buffer = Buffer.alloc(0);
    const response = {
      writeHead(next: number, values: Record<string, string>) {
        status = next;
        headers = values;
      },
      end(data: Buffer | string) {
        body = Buffer.from(data);
      },
    };
    const handled = await skillDownloadRoute(
      { method } as never,
      response as never,
      pathname,
      new URL(`http://inert.invalid${pathname}?${search}`),
      {
        readOnly: true,
        account: () => owner,
        sessionIdentity: identity,
        stateDirectory: () => stateRoot,
        isCurrent: () => active,
        call: async (name, ...args) => {
          assert.equal(name, "listSkills");
          assert.deepEqual(args, []);
          return list();
        },
      } as Parameters<typeof skillDownloadRoute>[4],
    );
    return { status, headers, body, handled };
  };
  return {
    directory,
    root,
    folder,
    id,
    inventory,
    identity,
    list,
    put,
    query,
    route,
    calls: () => calls,
    afterList(fn: () => void) {
      afterList = fn;
    },
    switchOwner() {
      owner = { ...account, id: "another-owner" };
    },
    switchActivation() {
      activation = {};
    },
    switchRoot() {
      stateRoot = directory;
    },
    retire() {
      active = false;
    },
    signOut() {
      owner = undefined;
    },
  };
}

test("original Contents and Download return the original bytes of every visible file", async (t) => {
  const f = fixture(t);
  f.put("notes/a/b/c/d/e/f/deep.txt", "deep");
  f.put(".private", "hidden");
  fs.symlinkSync(
    path.join(f.folder, "SKILL.md"),
    path.join(f.folder, "link.md"),
  );
  for (const trigger of ["view", "user", "download"]) {
    const response = await f.route(f.query(trigger));
    assert.equal(response.status, 200, response.body.toString());
    assert.equal(response.headers["Content-Type"], "application/zip");
    assert.equal(
      response.headers["Content-Disposition"],
      `attachment; filename="${f.id}.skill"`,
    );
    assert.equal(response.headers["Cache-Control"], "no-store");
    const zip = await JSZip.loadAsync(response.body);
    const expected = new Map([
      ["skill/SKILL.md", markdown],
      ["skill/assets/image.png", png],
      ["skill/notes/中文.txt", note],
      ["skill/notes/a/b/c/d/e/f/deep.txt", Buffer.from("deep")],
    ]);
    assert.deepEqual(
      Object.keys(zip.files).sort(),
      [...expected.keys()].sort(),
    );
    for (const [name, bytes] of expected)
      assert.deepEqual(await zip.file(name)?.async("nodebuffer"), bytes);
  }
});

test("the archive resolves an opaque ID only within the authenticated profile", async (t) => {
  const f = fixture(t);
  const foreign = path.join(f.directory, "SKILL.md");
  fs.writeFileSync(foreign, "foreign skill contents");
  f.inventory[0].skills.push({ name: "foreign", path: foreign });
  for (const search of [
    `skill_id=${encodeURIComponent(foreign)}`,
    `${f.query()}&path=${encodeURIComponent(foreign)}`,
    `${f.query()}&skill_id=${f.id}`,
    f.query("unexpected"),
  ])
    assert.equal((await f.route(search)).status, 400);
  assert.equal(
    (await f.route(f.query(), organizationUuid("other"))).status,
    404,
  );
  assert.equal((await f.route(f.query(), organization, "POST")).handled, false);
  assert.equal(f.calls(), 0);
  assert.equal((await f.route(`skill_id=skill_${"0".repeat(24)}`)).status, 404);
  const outside = await f.route(`skill_id=${skillId(foreign)}`);
  assert.notEqual(outside.status, 200);
  assert.ok(!outside.body.toString().includes(foreign));
  assert.ok(!outside.body.toString().includes("foreign skill contents"));
  f.signOut();
  assert.equal((await f.route()).status, 401);
});

test("account, activation, profile and retirement changes during inventory lookup withhold the archive", async (t) => {
  for (const change of [
    "switchOwner",
    "switchActivation",
    "switchRoot",
    "retire",
  ] as const) {
    const f = fixture(t);
    f.afterList(() => f[change]());
    const response = await f.route();
    assert.equal(response.status, 409, change);
    assert.notEqual(response.headers["Content-Type"], "application/zip");
  }
});

test("500 regular files fit in the archive and the next file fails the whole request", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 497; i++) f.put(`files/${i}.txt`, "sample");
  const supported = await f.route();
  assert.equal(supported.status, 200);
  assert.equal(
    Object.keys((await JSZip.loadAsync(supported.body)).files).length,
    500,
  );
  f.put("files/one-more.txt", "sample");
  const exceeded = await f.route();
  assert.equal(exceeded.status, 413);
  assert.notEqual(exceeded.headers["Content-Type"], "application/zip");
});

test("a skill at the 30 MiB import limit is complete and one additional byte is refused", async (t) => {
  const f = fixture(t);
  const resource = f.put("assets/large.bin", "");
  const size =
    skillImportLimits.bytes - markdown.length - note.length - png.length;
  fs.truncateSync(resource, size);
  const supported = await f.route();
  assert.equal(supported.status, 200);
  const zip = await JSZip.loadAsync(supported.body);
  assert.equal(
    (await zip.file("skill/assets/large.bin")?.async("uint8array"))?.length,
    size,
  );
  fs.truncateSync(resource, size + 1);
  const exceeded = await f.route();
  assert.equal(exceeded.status, 413);
  assert.notEqual(exceeded.headers["Content-Type"], "application/zip");
});

test("the exact official Web GET transfers a large ZIP and an old activation cannot continue it", async (t) => {
  const f = fixture(t);
  const resource = Buffer.alloc(officialUiReadMaxBytes + 5, 251);
  f.put("assets/large.bin", resource);
  const context = {
    userId: 7,
    activeAccount: account,
    signedOut: false,
    closedFlag: false,
    officialSessionIdentity: f.identity,
    store: { root: f.root, settings: {} },
    engine: {
      rpc: {
        async call(method: string) {
          assert.equal(method, "skills/list");
          return { data: await f.list() };
        },
      },
    },
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    selectedAttachments: new Map(),
    engineRunning: () => true,
    setAccessToken() {},
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
  };
  registerSkillHandlers(
    (name, handler) => context.handlers.set(name, handler),
    context as never,
  );
  const dispatcher = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: false,
    },
    guard: { modes: ["chat"] },
    methods: ["listSkills"],
    context: () => context,
    contextFor: async () => context,
    now: () => 0,
    newSession,
    run,
  };
  const read = (request: OfficialUiWireRequest) =>
    officialUiRead(
      dispatcher as never,
      {
        t: "call",
        id: "inert-skill-archive",
        method: "officialUiRead",
        args: encodeWireValue([request]),
        user: { id: context.userId, accessToken: "inert-not-a-credential" },
      } as never,
    ) as Promise<OfficialUiWireResponse>;

  const pathname = archivePath();
  const route = `${pathname}?${f.query("user")}`;
  assert.equal(isOfficialUiLargeResponse("GET", pathname), true);
  assert.equal(isOfficialUiLargeResponse("POST", pathname), false);
  assert.equal(isOfficialUiLargeResponse("GET", `${pathname}/extra`), false);
  assert.equal(
    isOfficialUiLargeResponse(
      "GET",
      pathname.replace(/\/download-dot-skill-file$/, "/list-skills"),
    ),
    false,
  );
  assert.equal((await read({ method: "GET", path: route })).status, 413);

  const fetch = createOfficialReadFetch(
    "https://inert.invalid",
    async (request) => {
      const activation = f.identity();
      const allowTransfer = isOfficialUiLargeResponse(
        request.method,
        request.path.split("?")[0],
      );
      const initial = await read({ ...request, responseTransfer: true });
      assert.ok(initial.responseTransfer);
      return collectOfficialResponse({
        initial,
        allowTransfer,
        isCurrent: () => f.identity() === activation,
        readChunk: (path) => read({ method: "GET", path }),
      });
    },
    async () => {
      throw Error("The archive must use the official read bridge.");
    },
  );
  const response = await fetch(route);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Disposition"),
    `attachment; filename="${f.id}.skill"`,
  );
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  assert.deepEqual(
    await zip.file("skill/assets/large.bin")?.async("nodebuffer"),
    resource,
  );
  assert.deepEqual(
    await zip.file("skill/assets/image.png")?.async("nodebuffer"),
    png,
  );

  const ticket = (
    await read({ method: "GET", path: route, responseTransfer: true })
  ).responseTransfer;
  assert.ok(ticket);
  f.switchActivation();
  const oldChunk = await read({
    method: "GET",
    path: officialResponseChunkPath(ticket.id, officialResponseChunkBytes),
  });
  assert.equal(oldChunk.status, 404);
});
