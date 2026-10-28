import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Gateway } from "../../electron/engine/gateway";
import {
  builtinImagegenSkill,
  installApiImageSkill,
  writeImageProviderFiles,
} from "../../electron/skills/api-image";
import { apiImageFiles } from "../../electron/skills/api-image-files";

test("image requests go to the service with the GPT group's key, whatever the model", async (t) => {
  const seen: { url?: string; auth?: string; type?: string; body?: string } =
    {};
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    Object.assign(seen, {
      url: req.url,
      auth: req.headers.authorization,
      type: req.headers["content-type"],
      body: Buffer.concat(chunks).toString(),
    });
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const bridge = new Gateway(() => ({
    provider: {
      id: "sub2api",
      name: "Claudex",
      model: "claude-opus-5-5",
      models: [],
      baseUrl: base,
      protocol: "responses",
      routes: [
        {
          groupId: 4,
          keyId: "sub2api:g4",
          primary: true,
          protocol: "responses",
          models: ["claude-opus-5-5"],
        },
        {
          groupId: 2,
          keyId: "sub2api:g2",
          primary: false,
          protocol: "responses",
          models: ["gpt-6.1-sol"],
        },
      ],
    } as never,
    apiKey: "claude-group-key",
    keyFor: (keyId) => (keyId === "sub2api:g2" ? "gpt-group-key" : ""),
  }));
  await bridge.start();
  t.after(() => bridge.close());

  const answer = await fetch(`${bridge.url}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "a fox" }),
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {
    data: [{ b64_json: "iVBORw0KGgo=" }],
  });
  assert.equal(seen.url, "/v1/images/generations");
  assert.equal(seen.auth, "Bearer gpt-group-key");
  assert.equal(JSON.parse(seen.body!).prompt, "a fox");

  // An edit's multipart body goes through as it is.
  await fetch(`${bridge.url}/images/edits`, {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=x",
      authorization: `Bearer ${bridge.token}`,
    },
    body: '--x\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nnight\r\n--x--\r\n',
  });
  assert.equal(seen.url, "/v1/images/edits");
  assert.match(seen.type!, /multipart\/form-data; boundary=x/);

  // Without the local token nothing reaches the service.
  const refused = await fetch(`${bridge.url}/images/generations`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(refused.status, 401);
});

test("the api-image skill and its provider files land in the codex home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const root = installApiImageSkill(home);
  for (const relative of Object.keys(apiImageFiles))
    assert.ok(fs.existsSync(path.join(root, ...relative.split("/"))), relative);
  assert.match(
    fs.readFileSync(path.join(root, "SKILL.md"), "utf8"),
    /^---\nname: api-image/,
  );
  const provider = writeImageProviderFiles(
    home,
    "http://127.0.0.1:5555/v1",
    "local-token",
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")),
    {
      OPENAI_API_KEY: "local-token",
    },
  );
  assert.equal(provider.model_provider, "claudex");
  assert.equal(
    provider.model_providers.claudex.base_url,
    "http://127.0.0.1:5555/v1",
  );
  assert.equal(
    builtinImagegenSkill(home),
    path.join(home, "skills", ".system", "imagegen", "SKILL.md"),
  );
});
