import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  reserveWindowsReceipt,
  type WindowsReceiptInput,
} from "../electron/official-ui/api/windows-rest-receipts";

const win = process.platform === "win32";
function fixture(t: any) {
  const namespace = `Software\\ClaudexReceiptTest\\${randomBytes(16).toString("hex")}`;
  const scope = randomBytes(32).toString("hex");
  t.after(() => {
    const result = spawnSync(
      "reg.exe",
      ["delete", `HKCU\\${namespace}`, "/f"],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(result.status, 0, "Synthetic registry key must be removed");
  });
  const input: WindowsReceiptInput = {
    scope,
    payload: "b".repeat(64),
    candidate: randomUUID(),
    turnKeys: ["c".repeat(64)],
    requestKey: "d".repeat(64),
    legacySlots: 0,
    capacity: 5,
  };
  return { namespace, input };
}
test(
  "Windows registry reservations survive a new process and reject altered payloads and reused request IDs",
  { skip: !win, timeout: 60000 },
  (t) => {
    const { namespace, input } = fixture(t);
    const first = reserveWindowsReceipt(input, namespace);
    assert.deepEqual(first, { status: "fresh", operationId: input.candidate });
    assert.deepEqual(
      reserveWindowsReceipt({ ...input, candidate: randomUUID() }, namespace),
      { status: "existing", operationId: input.candidate },
    );
    assert.equal(
      reserveWindowsReceipt(
        { ...input, payload: "e".repeat(64), candidate: randomUUID() },
        namespace,
      ).status,
      "conflict",
    );
    assert.equal(
      reserveWindowsReceipt(
        { ...input, turnKeys: ["f".repeat(64)], candidate: randomUUID() },
        namespace,
      ).status,
      "conflict",
    );
    assert.equal(
      reserveWindowsReceipt(
        {
          ...input,
          turnKeys: ["1".repeat(64)],
          requestKey: "2".repeat(64),
          candidate: randomUUID(),
        },
        namespace,
      ).status,
      "fresh",
    );
    assert.equal(
      reserveWindowsReceipt(
        {
          ...input,
          turnKeys: ["3".repeat(64)],
          requestKey: "4".repeat(64),
          candidate: randomUUID(),
        },
        namespace,
      ).status,
      "capacity",
    );
  },
);
test(
  "two Windows processes cannot both reserve the same turn",
  { skip: !win, timeout: 60000 },
  async (t) => {
    const { namespace, input } = fixture(t);
    const moduleUrl = pathToFileURL(
      path.resolve("electron/official-ui/api/windows-rest-receipts.ts"),
    ).href;
    const code = `import {reserveWindowsReceipt} from ${JSON.stringify(moduleUrl)};let s='';for await(const c of process.stdin)s+=c;const [v,n]=JSON.parse(s);process.stdout.write(JSON.stringify(reserveWindowsReceipt(v,n)));`;
    const run = (candidate: string) =>
      new Promise<any>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code],
          { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (x) => (out += x));
        child.stderr.on("data", (x) => (err += x));
        child.on("error", reject);
        child.on("exit", (status) =>
          status === 0 ? resolve(JSON.parse(out)) : reject(Error(err)),
        );
        child.stdin.end(JSON.stringify([{ ...input, candidate }, namespace]));
      });
    const results = await Promise.all([run(randomUUID()), run(randomUUID())]);
    assert.deepEqual(results.map((r) => r.status).sort(), [
      "existing",
      "fresh",
    ]);
    assert.equal(results[0].operationId, results[1].operationId);
  },
);
test(
  "invalid Windows registry data cannot authorize a send",
  { skip: !win, timeout: 60000 },
  (t) => {
    const { namespace, input } = fixture(t);
    reserveWindowsReceipt(input, namespace);
    const key = `HKCU\\${namespace}\\${input.scope}`;
    const changed = spawnSync(
      "reg.exe",
      ["add", key, "/v", input.turnKeys[0], "/t", "REG_SZ", "/d", "bad", "/f"],
      { windowsHide: true },
    );
    assert.equal(changed.status, 0);
    assert.throws(
      () =>
        reserveWindowsReceipt({ ...input, candidate: randomUUID() }, namespace),
      /storage failed/,
    );
  },
);

test(
  "Windows account receipts remain replay-safe when its profile directory moves",
  { skip: !win, timeout: 60000 },
  async (t) => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { reserveRestCompletion } =
      await import("../electron/official-ui/api/rest-completion-receipts");
    const { syntheticWindowsReceiptCleanup } =
      await import("./support/windows-receipt-cleanup");
    const owner = `receipt-test-${randomUUID()}`,
      firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-first-")),
      movedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-moved-"));
    const cleanup = syntheticWindowsReceiptCleanup(firstRoot, [owner]);
    t.after(() => {
      cleanup();
      fs.rmSync(firstRoot, { recursive: true, force: true });
      fs.rmSync(movedRoot, { recursive: true, force: true });
    });
    const identity = {},
      ctx = (root: string) =>
        ({
          account: () => ({ id: owner }),
          stateDirectory: () => root,
          sessionIdentity: () => identity,
          isCurrent: () => true,
        }) as any;
    const input = {
      conversationId: randomUUID(),
      humanId: randomUUID(),
      assistantId: randomUUID(),
      requestId: randomUUID(),
      payloadHash: "a".repeat(64),
    };
    const first = reserveRestCompletion(ctx(firstRoot), input);
    assert.equal(first.fresh, true);
    assert.deepEqual(reserveRestCompletion(ctx(movedRoot), input), {
      fresh: false,
      operationId: first.operationId,
    });
    assert.throws(
      () =>
        reserveRestCompletion(ctx(movedRoot), {
          ...input,
          payloadHash: "b".repeat(64),
        }),
      (error: any) => error.status === 409,
    );
  },
);

test(
  "a partial Windows write and a legacy binding can never become a fresh send",
  { skip: !win, timeout: 60000 },
  (t) => {
    const { namespace, input } = fixture(t);
    const key = `HKCU\\${namespace}\\${input.scope}`;
    const added = spawnSync(
      "reg.exe",
      [
        "add",
        key,
        "/v",
        input.turnKeys[0],
        "/t",
        "REG_SZ",
        "/d",
        `${input.payload}:${input.candidate}`,
        "/f",
      ],
      { windowsHide: true },
    );
    assert.equal(added.status, 0);
    const result = reserveWindowsReceipt(
      { ...input, candidate: randomUUID() },
      namespace,
    );
    assert.deepEqual(result, {
      status: "existing",
      operationId: input.candidate,
    });
    const legacy = randomUUID(),
      otherScope = randomBytes(32).toString("hex");
    const migration = reserveWindowsReceipt(
      {
        ...input,
        scope: otherScope,
        legacyTurn: legacy,
        candidate: randomUUID(),
      },
      namespace,
    );
    assert.deepEqual(migration, { status: "existing", operationId: legacy });
    assert.deepEqual(
      reserveWindowsReceipt(
        { ...input, scope: otherScope, candidate: randomUUID() },
        namespace,
      ),
      { status: "existing", operationId: legacy },
    );
  },
);

test(
  "Windows imports a legacy alias before permitting any retry",
  { skip: !win, timeout: 60000 },
  async (t) => {
    const fs = await import("node:fs"),
      os = await import("node:os"),
      crypto = await import("node:crypto");
    const { reserveRestCompletion } =
      await import("../electron/official-ui/api/rest-completion-receipts");
    const { syntheticWindowsReceiptCleanup } =
      await import("./support/windows-receipt-cleanup");
    const owner = `receipt-legacy-${randomUUID()}`,
      root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-legacy-"));
    const cleanup = syntheticWindowsReceiptCleanup(root, [owner]);
    t.after(() => {
      cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const hash = (value: unknown) =>
      crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const real = randomUUID(),
      old = randomUUID(),
      human = randomUUID(),
      assistant = randomUUID(),
      operationId = randomUUID(),
      payloadHash = "a".repeat(64);
    const directory = path.join(
      root,
      "official-rest-completion-receipts-" + hash(owner).slice(0, 24),
    );
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "capacity-v1"),
      "claudex-receipts-slots-v1\n",
    );
    fs.writeFileSync(path.join(directory, "capacity-slot-0"), "legacy");
    const key = hash(["turn", owner, old, human, assistant]);
    fs.writeFileSync(
      path.join(directory, key + ".json"),
      JSON.stringify({ version: 1, key, payloadHash, operationId }),
    );
    const ctx = {
      account: () => ({ id: owner }),
      stateDirectory: () => root,
      sessionIdentity: () => 1,
      isCurrent: () => true,
    } as any;
    const input = {
      conversationId: real,
      humanId: human,
      assistantId: assistant,
      payloadHash,
    };
    assert.deepEqual(
      reserveRestCompletion(ctx, input, { equivalentConversationIds: [old] }),
      { fresh: false, operationId },
    );
    fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(reserveRestCompletion(ctx, input), {
      fresh: false,
      operationId,
    });
  },
);
