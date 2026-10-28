import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useElectronShim } from "../runner/runner-core-support.test.ts";

useElectronShim();
const { registerSkillHandlers } = await import("../../electron/ipc/skills");

test("desktop and runner skill installs await the authenticated service scan before writing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-service-"));
  const calls: { token: string; route: string; body: any }[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  let blocked = true;
  const context = {
    store: { root, settings: {}, flush() {} },
    engine: {},
    window: undefined,
    remote: {
      session: {
        authorized: (action: (token: string) => Promise<unknown>) =>
          action("user-token"),
      },
      backend: {
        client: {
          directoryRequest: async (token: string, route: string, init: any) => {
            calls.push({ token, route, body: init.body });
            if (blocked) throw new Error("scan rejected");
            return { passed: true };
          },
        },
      },
    },
  };
  registerSkillHandlers(
    (name, handler) => handlers.set(name, handler),
    context as any,
  );
  const upload = [
    {
      name: "example.md",
      data: Buffer.from("---\nname: example\n---\nHelpful skill"),
    },
  ];
  try {
    await assert.rejects(
      handlers.get("installSkillFiles")!(upload),
      /scan rejected/,
    );
    assert.equal(
      fs.existsSync(path.join(root, "codex-home", "skills", "example")),
      false,
    );
    blocked = false;
    assert.deepEqual(await handlers.get("installSkillFiles")!(upload), [
      "example",
    ]);
    assert.equal(
      fs.existsSync(
        path.join(root, "codex-home", "skills", "example", "SKILL.md"),
      ),
      true,
    );
    assert.equal(calls[0].token, "user-token");
    assert.equal(calls[0].route, "/claudex/skills/scan");
    assert.equal(
      Buffer.from(calls[0].body.files[0].data, "base64").toString(),
      upload[0].data.toString(),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
