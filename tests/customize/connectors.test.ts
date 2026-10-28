import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConnectorTokens,
  connectorHosts,
  connectorUrlGuard,
} from "../../runner/src/connectors";
import { userNetworkPolicy } from "../../runner/src/net-policy-compile";
import { validBearerToken } from "../../electron/connectors/mcp-config-file";

const resolver = (map: Record<string, string[]>) => async (host: string) => {
  if (!map[host]) throw new Error("ENOTFOUND");
  return map[host];
};
const guard = connectorUrlGuard(
  { level: "trusted", deniedHosts: ["claudex.example"] },
  resolver({
    "mcp.example.com": ["93.184.216.34"],
    "rebind.example.com": ["93.184.216.34", "10.0.0.5"],
    "claudex.example": ["93.184.216.34"],
  }),
);

test("a connector address must be https, on a public name the sandbox could reach", async () => {
  await guard("https://mcp.example.com/mcp");
  const refuse = (address: string, message: RegExp) =>
    assert.rejects(() => guard(address), message);
  await refuse("http://mcp.example.com/mcp", /https/);
  await refuse("https://user:pw@mcp.example.com/", /https/);
  await refuse("https://mcp.example.com:8443/", /standard https port/);
  await refuse("not a url", /full address/);
  await refuse("https://localhost/mcp", /can't be reached/);
  await refuse("https://127.0.0.1/mcp", /can't be reached/);
  await refuse("https://169.254.169.254/latest", /can't be reached/);
  await refuse("https://db.internal/", /can't be reached/);
  // The Claudex service itself is never a connector.
  await refuse("https://claudex.example/api", /can't be reached/);
  // A name with any private answer is refused whole (rebinding).
  await refuse("https://rebind.example.com/", /can't be reached/);
  await refuse("https://nowhere.example.com/", /could not be found/);
});

test("connector hosts are the bare names of the remote servers", () => {
  assert.deepEqual(
    connectorHosts({
      a: { url: "https://mcp.example.com/x" },
      b: { url: "https://MCP.example.com:443/y" },
      c: { command: "npx" },
      d: { url: "not a url" },
    }),
    ["mcp.example.com"],
  );
});

test("a bearer token has no spaces or control characters", () => {
  assert.equal(validBearerToken("  abc.DEF-123 "), "abc.DEF-123");
  assert.equal(validBearerToken(""), undefined);
  assert.equal(validBearerToken(undefined), undefined);
  for (const bad of ["a b", "a\nb", "x".repeat(4097)])
    assert.throws(() => validBearerToken(bad), /isn't valid/);
});

test("tokens live in a private file, replaced atomically and forgotten with their connector", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-tokens-"));
  try {
    const tokens = new ConnectorTokens(dir);
    tokens.set("one", "t1");
    tokens.set("two", "t2");
    const file = path.join(dir, "connector-tokens.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(new ConnectorTokens(dir).get("one"), "t1");
    tokens.keepOnly(["two"]);
    assert.equal(new ConnectorTokens(dir).get("one"), undefined);
    assert.equal(new ConnectorTokens(dir).get("two"), "t2");
    tokens.set("two", undefined);
    assert.equal(new ConnectorTokens(dir).get("two"), undefined);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("connector hosts stay reachable when the rest of the network is closed", () => {
  const admin = { level: "trusted" } as const;
  const closed = userNetworkPolicy(admin, {
    enabled: false,
    allowlist: "packages",
    domains: [],
    connectors: ["mcp.example.com"],
  });
  assert.equal(closed.level, "custom");
  assert.deepEqual(closed.trustedDomains, []);
  assert.deepEqual(closed.customDomains, ["mcp.example.com"]);
  // With the network open they join the user's other domains.
  const open = userNetworkPolicy(admin, {
    enabled: true,
    allowlist: "packages",
    domains: ["a.example.org"],
    connectors: ["mcp.example.com"],
  });
  assert.deepEqual(open.customDomains, ["a.example.org", "mcp.example.com"]);
  // A service with the network off keeps it off for connectors too.
  assert.equal(
    userNetworkPolicy(
      { level: "none" },
      {
        enabled: true,
        allowlist: "all",
        domains: [],
        connectors: ["x.example.com"],
      },
    ).level,
    "none",
  );
});
