import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { gatewayCompleter } from "../electron/memory/completion";
import { createApiAdapter } from "../electron/official-ui/api";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";

test("the original Code title route calls only the signed-in host completer", async (t) => {
  let current = true;
  let retireDuringCompletion = false;
  const settings: Pick<
    ReturnType<AdapterContext["settings"]>,
    "codeBranchPrefix"
  > = {};
  const models: (string | undefined)[] = [];
  const owner = {
    id: "title-test-owner",
    email: "title@example.test",
    name: "Fixture",
  };
  const context = {
    account: () => owner,
    settings: () => settings,
    isCurrent: () => current,
    async completeCodeTitle(prompt, options) {
      models.push(options.model);
      assert.equal(prompt.input, "Fix the login screen");
      assert.match(prompt.instructions, /untrusted session content/);
      assert.equal(options?.maxOutputTokens, 256);
      assert.equal(options?.signal?.aborted, false);
      if (retireDuringCompletion) current = false;
      return "  Login screen\nrepair  ";
    },
  } satisfies Pick<
    AdapterContext,
    "account" | "isCurrent" | "completeCodeTitle"
  > & { settings: () => typeof settings };
  const adapter = createApiAdapter(context as AdapterContext, {
    scoped: false,
  });
  const server = http.createServer((req, res) => {
    void adapter(req, res)
      .then((handled) => {
        if (!handled) res.writeHead(501).end();
      })
      .catch((error) => res.writeHead(500).end(String(error)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const org = organizationUuid(owner.id);
  const request = (
    organization: string,
    firstMessage: string,
    withBranch = false,
  ) =>
    fetch(
      `${origin}/api/organizations/${organization}/dust/${withBranch ? "generate_title_and_branch" : "generate_session_title"}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          first_session_message: firstMessage,
          ...(withBranch
            ? { title_style: "default", model: "allowed-model" }
            : {}),
        }),
      },
    );

  assert.equal(
    (await request("another-org", "Fix the login screen")).status,
    403,
  );
  assert.equal((await request(org, " ")).status, 400);
  assert.equal((await request(org, "x".repeat(70_000))).status, 413);
  assert.equal(models.length, 0);

  const answer = await request(org, " Fix the login screen ");
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { title: "Login screen repair" });
  for (const [preference, expected] of [
    [undefined, "claude"],
    ["Team_42", "Team_42"],
    ["", "claude"],
  ] as const) {
    settings.codeBranchPrefix = preference;
    const startup = await request(org, "Fix the login screen", true);
    assert.equal(startup.status, 200);
    assert.deepEqual(await startup.json(), {
      title: "Login screen repair",
      branch_name: `${expected}/login-screen-repair`,
    });
  }
  retireDuringCompletion = true;
  assert.equal((await request(org, "Fix the login screen")).status, 409);
  assert.deepEqual(models, [
    undefined,
    "allowed-model",
    "allowed-model",
    "allowed-model",
    undefined,
  ]);
});

test("a title request aborted while waiting for the gateway never dispatches", async () => {
  const controller = new AbortController();
  const complete = gatewayCompleter(
    async () => {
      controller.abort();
      return {
        url: "http://127.0.0.1:1/v1",
        token: "fixture",
        model: "fixture",
      };
    },
    async () => assert.fail("The retired title request reached the gateway"),
  );
  await assert.rejects(
    complete(
      { instructions: "Title only", input: "Example" },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
});
