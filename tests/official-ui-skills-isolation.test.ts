import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillsRoute } from "../electron/official-ui/api/skills";

test("one account cannot edit a skill listed by another account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-skill-isolation-"));
  const file = path.join(root, "SKILL.md");
  fs.writeFileSync(file, "Original content\n");
  const context = (skills: unknown[]) => ({ call: async (op: string) => {
    if (op !== "listSkills") throw Error(`Unexpected operation ${op}`);
    return [{ skills }];
  } });
  const a = context([{ name: "private", path: file, scope: "user", enabled: true }]);
  const b = context([]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const ctx = req.headers["x-test-account"] === "a" ? a : b;
    void skillsRoute(req, res, url.pathname, url, ctx as never);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/api/organizations/x/skills`;
    const response = await fetch(`${base}/list-skills`, { headers: { "x-test-account": "a" } });
    const listed = await response.json() as { skills: { id: string }[] };
    assert.equal(listed.skills.length, 1);
    const edit = await fetch(`${base}/edit-simple-skill`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-account": "b" },
      body: JSON.stringify({ skill_id: listed.skills[0].id, description: "changed", instructions: "changed" }),
    });
    assert.equal(edit.status, 404);
    assert.equal(fs.readFileSync(file, "utf8"), "Original content\n");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
