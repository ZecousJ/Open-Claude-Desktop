import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinearClient } from "../../electron/connectors/linear";
import { linearExtension } from "../../electron/connectors/linear-extension";
import {
  EngineExtensions,
  type EngineExtension,
} from "../../electron/engine/engine-extensions";
import { registerLinearHandlers } from "../../electron/ipc/linear";
import {
  linearIssueLabel,
  linearMcpUrl,
  withLinearIssue,
  type LinearIssue,
} from "../../shared/linear-api";
import { openPolicy } from "../../shared/client-policy";
import { webMethodKind } from "../../shared/web-bridge-methods";
import { ConnectorTokens } from "../../runner/src/connectors";
import LinearIssuePill from "../../src/linear/LinearIssuePill";

const issue: LinearIssue = {
  identifier: "ENG-42",
  title: "Fix startup",
  url: "https://linear.app/team/issue/ENG-42/fix-startup",
  state: "In Progress",
  stateColor: "#5e6ad2",
  team: "Engineering",
};

test("Linear import uses the official label, removable pill and URL context, not a file", () => {
  assert.equal(linearIssueLabel(issue), "ENG-42 Fix startup");
  assert.equal(linearIssueLabel({ ...issue, title: "ENG-42" }), "ENG-42");
  assert.equal(
    withLinearIssue("Investigate", issue),
    `Investigate\n\nLinear issue: ${issue.url}`,
  );
  assert.equal(withLinearIssue("", issue), `Linear issue: ${issue.url}`);
  assert.equal(withLinearIssue("unchanged"), "unchanged");
  const html = renderToStaticMarkup(
    createElement(LinearIssuePill, { issue, onRemove() {} }),
  );
  assert.match(html, /ENG-42 Fix startup/);
  assert.match(html, /aria-label="Remove ENG-42 Fix startup"/);
  assert.doesNotMatch(html, /\.md|attachment-tile/);
});

test("Linear searches assigned issues by default, searches all issues with variables and keeps credentials server-side", async () => {
  const requests: { address: string; options: RequestInit; body: any }[] = [];
  const client = new LinearClient(async (address, options) => {
    const body = JSON.parse(String(options?.body));
    requests.push({ address: String(address), options: options!, body });
    const node = {
      ...issue,
      state: { name: issue.state, color: issue.stateColor },
      team: { name: issue.team },
    };
    return Response.json({
      data: body.query.includes("viewer")
        ? { viewer: { assignedIssues: { nodes: [node] } } }
        : {
            issues: {
              nodes: [
                node,
                { ...node, url: "javascript:alert(1)" },
                { ...node, url: "https://linear.app.evil.test/issue/1" },
              ],
            },
          },
    });
  });
  assert.deepEqual(await client.issues("secret", ""), [issue]);
  assert.deepEqual(
    await client.issues("secret", '\" } query { viewer { id } }'),
    [issue],
  );
  assert.match(requests[0].body.query, /viewer.*assignedIssues/);
  assert.match(requests[1].body.query, /searchIssues\(term: \$query/);
  assert.equal(
    requests[1].body.variables.query,
    '\" } query { viewer { id } }',
  );
  assert.equal(requests[1].address, "https://api.linear.app/graphql");
  assert.equal(
    (requests[1].options.headers as Record<string, string>).Authorization,
    "secret",
  );
  assert.equal(requests[1].options.redirect, "error");
  assert.ok(requests[1].options.signal);
});

test("Linear never returns service errors or credentials to the renderer", async () => {
  const client = new LinearClient(async () =>
    Response.json({ errors: [{ message: "bad credential: secret" }] }),
  );
  await assert.rejects(client.connect("secret"), {
    message: "Unable to load Linear issues.",
  });
  await assert.rejects(client.issues("secret", ""), {
    message: "Unable to load Linear issues.",
  });
});

function handlers(root: string, extra: Record<string, unknown> = {}) {
  const methods = new Map<string, (...args: any[]) => any>();
  let policy = structuredClone(openPolicy);
  const client = new LinearClient();
  client.connect = async (key) => {
    if (key === "bad") throw Error("invalid");
  };
  client.issues = async (key) => {
    assert.equal(key, "lin_api_secret");
    return [issue];
  };
  const context = {
    store: { root },
    credentials: { canPersist: true, vaultKey: "a".repeat(64) },
    policy: () => policy,
    ...extra,
  };
  registerLinearHandlers(
    (name, handler) => methods.set(name, handler),
    context as never,
    client,
  );
  return {
    call: (name: string, ...args: unknown[]) => methods.get(name)!(...args),
    block: () => {
      policy = { ...policy, connectors: [] };
    },
  };
}

test("Linear connect validates before replacing a key, encrypts it, survives restart, disconnects and enforces policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-linear-"));
  try {
    const first = handlers(root);
    assert.deepEqual(first.call("linearStatus"), { connected: false });
    await first.call("linearConnect", "lin_api_secret");
    assert.deepEqual(first.call("linearStatus"), { connected: true });
    const file = path.join(root, "linear", "backend", "provider-keys.enc");
    assert.ok(!fs.readFileSync(file, "utf8").includes("lin_api_secret"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    await assert.rejects(first.call("linearConnect", "bad"));
    const restarted = handlers(root);
    assert.deepEqual(await restarted.call("linearIssues", "startup"), [issue]);
    assert.deepEqual(
      handlers(path.join(root, "another-account")).call("linearStatus"),
      { connected: false },
    );
    restarted.block();
    assert.deepEqual(restarted.call("linearStatus"), { connected: false });
    assert.throws(() => restarted.call("linearIssues"), /administrator/);
    first.call("linearDisconnect");
    assert.deepEqual(handlers(root).call("linearStatus"), { connected: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the web uses per-user runner credentials, never browser storage or settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-linear-runner-"));
  try {
    const first = handlers(root, {
      credentials: { canPersist: false },
      integrationTokens: new ConnectorTokens(root),
    });
    await first.call("linearConnect", "lin_api_secret");
    const restarted = handlers(root, {
      credentials: { canPersist: false },
      integrationTokens: new ConnectorTokens(root),
    });
    assert.deepEqual(await restarted.call("linearIssues"), [issue]);
    assert.equal(
      fs.statSync(path.join(root, "connector-tokens.json")).mode & 0o777,
      0o600,
    );
    for (const name of [
      "linearStatus",
      "linearConnect",
      "linearDisconnect",
      "linearIssues",
    ])
      assert.equal(webMethodKind(name), "remote-runner");
    restarted.call("linearDisconnect");
    assert.deepEqual(new ConnectorTokens(root).get("linear"), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the connected account provides the agent's Linear tools and removes them after disconnect or a policy change", () => {
  let key = "lin_api_secret";
  let allowed = true;
  const extension = linearExtension(
    () => key,
    () => allowed,
  );
  const servers = () => extension.builtinMcpServers!({ mode: "code" } as never);
  assert.deepEqual(servers(), [
    {
      name: "claudex_linear",
      url: linearMcpUrl,
      httpHeaders: { Authorization: "Bearer lin_api_secret" },
      defaultToolsApprovalMode: "prompt",
    },
  ]);
  allowed = false;
  assert.equal(servers(), undefined);
  allowed = true;
  key = "";
  assert.equal(servers(), undefined);
  key = "lin_api_secret";
  assert.equal(
    extension.builtinMcpServers!({ mode: "chat" } as never),
    undefined,
  );
});

test("account activation installs Linear for peer engines; sign-out removes it and forgets in-memory credentials", async () => {
  let activate = () => {};
  let deactivate = () => {};
  const engine = {
    extensions: new EngineExtensions(),
    peerExtensions: [] as EngineExtension[],
  };
  const account = handlers(".", {
    credentials: { canPersist: false },
    engine,
    onAccountActivated(callback: () => void) {
      activate = callback;
    },
    onAccountDeactivating(callback: () => void) {
      deactivate = callback;
    },
  });
  activate();
  assert.ok(engine.extensions.has("linear"));
  await account.call("linearConnect", "lin_api_secret");
  assert.equal(engine.peerExtensions.length, 1);
  assert.ok(
    engine.peerExtensions[0].builtinMcpServers!({ mode: "code" } as never),
  );
  deactivate();
  assert.equal(engine.extensions.has("linear"), false);
  assert.equal(engine.peerExtensions.length, 0);
  assert.deepEqual(account.call("linearStatus"), { connected: false });
});
