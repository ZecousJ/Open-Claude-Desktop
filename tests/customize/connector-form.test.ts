import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectorNameError,
  connectorServerId,
  connectorUrlError,
  connectorUsesSse,
} from "../../shared/custom-connector";
import {
  connectorSuggestion,
  desktopConnectorLink,
} from "../../shared/connector-links";
import {
  connectorConfigurationError,
  connectorRegexError,
  templateConnectorUrl,
} from "../../shared/connector-url-configuration";
import {
  ConnectorClients,
  connectorOAuthClient,
} from "../../electron/connectors/connector-clients";
import { probeConnector } from "../../electron/connectors/connector-probe";
import {
  customConnectorEntry,
  mcpServerStates,
} from "../../electron/connectors/mcp-config-file";
import { directorySubmissionInput } from "../../shared/directory-submissions-input";
import { openSseConnector } from "../../electron/connectors/connector-sse";
import { createHash } from "node:crypto";
import { ConnectorTokens } from "../../runner/src/connectors";
import {
  desktopConnectorHeaders,
  forgetDesktopConnectorToken,
} from "../../electron/connectors/connector-auth";
import { readSource } from "../support/read-source";

test("personal connector URLs require HTTPS, names retain user-facing text, and SSE is detected", () => {
  for (const url of [
    "http://localhost:3000/mcp",
    "https://localhost/mcp",
    "https://10.0.0.1/mcp",
    "https://192.168.0.1/mcp",
    "http://example.com/mcp",
    "file:///tmp/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/${token}",
    "not a url",
  ])
    assert.ok(connectorUrlError(url), url);
  assert.equal(connectorUrlError(" https://mcp.example.com/mcp "), undefined);
  assert.equal(connectorUsesSse("https://example.com/sse?key=value"), true);
  assert.equal(connectorUsesSse("https://example.com/mcp"), false);
  assert.equal(connectorNameError(" My connector ", ["MY CONNECTOR"]), true);
  assert.equal(
    connectorServerId("My connector", ["My-connector"]),
    "My-connector-2",
  );
  assert.equal(connectorServerId("连接器", []), "connector");
  const [name, entry] = customConnectorEntry(
    {
      name: "my-connector",
      displayName: "My connector",
      url: "https://example.com/mcp",
    },
    {},
  );
  assert.equal(
    mcpServerStates({ [name]: entry }, false, new Map(), [])[0].displayName,
    "My connector",
  );
  assert.throws(
    () =>
      customConnectorEntry(
        {
          name: "other",
          displayName: "MY CONNECTOR",
          url: "https://example.com/mcp",
        },
        { [name]: entry },
      ),
    /already exists/,
  );
});

test("connector edits retain runtime identity and permissions but drop credentials after URL changes", () => {
  const previous = {
    url: "https://example.com/mcp",
    display_name: "Original",
    enabled: false,
    disabled_tools: ["delete"],
    bearer_token_env_var: "CONNECTOR_TOKEN",
    http_headers: { Authorization: "Bearer private" },
  };
  const input = {
    name: "original",
    replaceName: "original",
    displayName: "Renamed",
    url: previous.url,
  };
  const [name, entry] = customConnectorEntry(input, { original: previous });
  assert.equal(name, "original");
  assert.equal(entry.display_name, "Renamed");
  assert.equal(entry.enabled, false);
  assert.deepEqual(entry.disabled_tools, ["delete"]);
  assert.equal(entry.bearer_token_env_var, "CONNECTOR_TOKEN");
  const [, changed] = customConnectorEntry(
    { ...input, url: "https://other.example.com/mcp" },
    { original: previous },
  );
  assert.equal(changed.http_headers, undefined);
  assert.equal(changed.bearer_token_env_var, undefined);
  assert.throws(() => customConnectorEntry(input, {}), /no longer exists/);
  assert.throws(
    () =>
      customConnectorEntry(
        { ...input, displayName: "Taken" },
        { original: previous, other: { display_name: "Taken" } },
      ),
    /already exists/,
  );
});

test("external connector prefills cross web and native links without installing anything", () => {
  const params = new URLSearchParams({
    connectorName: "Example connector",
    connectorUrl: "https://example.com/mcp",
  });
  const link = `claudex://settings/connectors?${params}`;
  const expected = {
    name: "Example connector",
    url: "https://example.com/mcp",
  };
  assert.deepEqual(
    connectorSuggestion(`https://app.example.com/?${params}`),
    expected,
  );
  const encoded = desktopConnectorLink(link)!;
  assert.deepEqual(
    connectorSuggestion(
      `https://app.example.com/?${new URLSearchParams({ connector: encoded })}`,
    ),
    expected,
  );
  assert.equal(
    desktopConnectorLink(link.replace("claudex:", "https:")),
    undefined,
  );
  assert.equal(
    connectorSuggestion(`https://example.com/?connector=suggested:bad`),
    undefined,
  );
  assert.equal(
    connectorSuggestion(
      `https://example.com/?connectorUrl=${"a".repeat(2049)}`,
    ),
    undefined,
  );
  assert.equal(
    desktopConnectorLink(
      "claudex://settings/connectors?connector=installed:example",
    ),
    "installed:example",
  );
});

test("custom OAuth clients live in a private credential file, never a connector config", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-client-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = connectorOAuthClient({
    clientId: " client ",
    clientSecret: " secret ",
  });
  const clients = new ConnectorClients(root);
  clients.set("example", client);
  assert.equal(
    fs.statSync(path.join(root, "connector-clients.json")).mode & 0o777,
    0o600,
  );
  assert.deepEqual(new ConnectorClients(root).get("example"), {
    clientId: "client",
    clientSecret: "secret",
  });
  const [, entry] = customConnectorEntry(
    { name: "example", url: "https://example.com/mcp", ...client },
    {},
  );
  assert.deepEqual(entry, { url: "https://example.com/mcp" });
  assert.throws(
    () => connectorOAuthClient({ clientSecret: "secret" }),
    /client ID/,
  );
  assert.throws(
    () => connectorOAuthClient({ clientId: "bad\nclient" }),
    /valid/,
  );
  clients.set("example");
  assert.equal(new ConnectorClients(root).get("example"), undefined);
});

test("server probe uses bounded MCP initialization and reports OAuth without exposing responses", async () => {
  for (const status of [200, 401, 403]) {
    const request = (async (address, init) => {
      assert.equal(address, "https://example.com/mcp");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(JSON.parse(String(init?.body)).method, "initialize");
      assert.ok(init?.signal);
      return new Response("private server response", { status });
    }) as typeof fetch;
    assert.deepEqual(await probeConnector("https://example.com/mcp", request), {
      authRequired: status !== 200,
    });
  }
  await assert.rejects(
    probeConnector("http://localhost", async () => {
      throw Error("must not fetch");
    }),
    /https/,
  );
  await assert.rejects(
    probeConnector(
      "https://example.com/mcp",
      async () => new Response("private error", { status: 500 }),
    ),
    /request failed/,
  );
});

test("submission URL variants validate fixed lists, whole-host regexes, and customer templates", () => {
  const address = "https://us.mcp.example.com/mcp";
  assert.equal(
    connectorConfigurationError(
      { serverUrlType: "multiple", remoteUrlOptions: [{ url: address }] },
      address,
    ),
    undefined,
  );
  assert.ok(
    connectorConfigurationError(
      { serverUrlType: "multiple", remoteUrlOptions: [{ url: address }] },
      "https://evil.test/mcp",
    ),
  );
  const pattern = "^https://[a-z0-9-]+\\.mcp\\.example\\.com/mcp$";
  assert.equal(connectorRegexError(pattern), undefined);
  for (const bad of [
    "https://example.com",
    "^https://.*$",
    "^https://[a-z]+\\.example\\.com",
    "^https://(a+)+\\.example\\.com$",
    "^https://(?=a)a\\.example\\.com$",
    "^https://a\\.example\\.com$|https://evil.test$",
  ])
    assert.ok(connectorRegexError(bad), bad);
  assert.equal(
    connectorConfigurationError({
      serverUrlType: "regex",
      remoteUrlRegex: pattern,
      testServerUrl: address,
    }),
    undefined,
  );
  assert.ok(
    connectorConfigurationError(
      { serverUrlType: "regex", remoteUrlRegex: pattern },
      "https://evil.test",
    ),
  );
  const template = {
    serverUrlType: "template" as const,
    remoteUrlTemplate: "https://${user_config.org}.mcp.example.com/mcp",
    remoteUserConfig: {
      title: "Organization",
      description: "Your organization",
      placeholder: "acme",
      pattern: "^[a-z0-9-]{1,63}$",
    },
  };
  assert.equal(
    templateConnectorUrl(template),
    "https://acme.mcp.example.com/mcp",
  );
  assert.equal(connectorConfigurationError(template, address), undefined);
  assert.ok(
    connectorConfigurationError(
      template,
      "https://us.mcp.example.com.evil.test/mcp",
    ),
  );
  assert.ok(
    connectorConfigurationError({
      ...template,
      remoteUserConfig: { ...template.remoteUserConfig, pattern: "^[z-a]+$" },
    }),
  );
  const submission = {
    kind: "mcp",
    name: "Example",
    slug: "example",
    url: address,
    description: "Example",
    examples: "",
    email: "me@example.com",
    license: "MIT",
    termsAcknowledged: true,
    toolsVerified: true,
    tools: ["read"],
    ...template,
  };
  assert.equal(
    directorySubmissionInput.parse(submission).remoteUrlTemplate,
    template.remoteUrlTemplate,
  );
});

test("connector dialogs and submission URL editor remain lazy", () => {
  const connectors = readSource("src/settings/tabs/Connectors.tsx");
  assert.match(
    connectors,
    /lazyPiece\(\s*\(\) => import\("\.\/AddConnectorDialog"\),?\s*\)/,
  );
  assert.match(connectors, /label: "Browse connectors"/);
  assert.match(connectors, /setView\("discover"\)/);
  assert.match(connectors, /An external link suggested this connector/);
  const submission = fs.readFileSync(
    "src/collections/customize/DirectorySubmissionsPage.tsx",
    "utf8",
  );
  assert.match(
    submission,
    /lazyPiece\(\(\) => import\("\.\/ConnectorUrlEditor"\)\)/,
  );
});

test("desktop OAuth tokens and custom clients are bound to their original server URL", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-scoped-client-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resource = "https://example.com/mcp";
  const profile = path.join(
    root,
    "connector-auth",
    createHash("sha256").update(resource).digest("hex"),
  );
  fs.mkdirSync(profile, { recursive: true });
  new ConnectorTokens(profile).set("example", "private-bearer");
  assert.deepEqual(desktopConnectorHeaders(root, "example", resource), {
    Authorization: "Bearer private-bearer",
  });
  assert.equal(
    desktopConnectorHeaders(root, "example", "https://other.test/mcp"),
    undefined,
  );
  const clients = new ConnectorClients(root);
  clients.set(
    "example",
    { clientId: "client", clientSecret: "secret" },
    resource,
  );
  assert.equal(clients.get("example", resource)?.clientSecret, "secret");
  assert.equal(clients.get("example", "https://other.test/mcp"), undefined);
  forgetDesktopConnectorToken(root, "example", resource);
  assert.equal(desktopConnectorHeaders(root, "example", resource), undefined);
});

test("legacy SSE transport forwards MCP messages and never posts credentials to another origin", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const received: unknown[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const request = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === "POST") return new Response(null, { status: 202 });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
          controller.enqueue(
            encoder.encode(
              "event: endpoint\ndata: /messages?session=private\n\n",
            ),
          );
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const transport = await openSseConnector(
    "https://example.com/sse",
    request,
    { Authorization: "Bearer private" },
    (message) => received.push(message),
  );
  await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(calls[1].url, "https://example.com/messages?session=private");
  assert.equal(
    new Headers(calls[1].init?.headers).get("Authorization"),
    "Bearer private",
  );
  controller.enqueue(
    encoder.encode(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ jsonrpc: "2.0", id: 1, result: {} }]);
  transport.close();
  await transport.completed;
  await assert.rejects(
    openSseConnector(
      "https://example.com/sse",
      async () =>
        new Response("event: endpoint\ndata: https://evil.test/messages\n\n"),
      {},
      () => {},
    ),
    /request failed/,
  );
});
