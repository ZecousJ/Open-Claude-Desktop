import test from "node:test";
import assert from "node:assert/strict";
import { type NetPolicy } from "../../runner/src/net-policy";
import { userNetworkPolicy } from "../../runner/src/net-policy-compile";
import { preferenceFields } from "../../shared/settings-extras-schema";

const trusted: NetPolicy = {
  level: "trusted",
  deniedHosts: ["claudex.example"],
};
const on = { enabled: true, allowlist: "packages", domains: [] } as const;

test("the service's level is the ceiling: none stays closed whatever the user chose", () => {
  const none: NetPolicy = { level: "none" };
  assert.equal(
    userNetworkPolicy(none, {
      enabled: true,
      allowlist: "all",
      domains: ["a.com"],
    }).level,
    "none",
  );
});

test("a user can close the network or leave it as the service has it", () => {
  assert.deepEqual(userNetworkPolicy(trusted, on), trusted);
  assert.equal(
    userNetworkPolicy(trusted, { ...on, enabled: false }).level,
    "none",
  );
  assert.equal(
    userNetworkPolicy(trusted, { ...on, allowlist: "none" }).level,
    "none",
  );
  // The denied names stay with the closed policy too.
  assert.deepEqual(
    userNetworkPolicy(trusted, { ...on, enabled: false }).deniedHosts,
    ["claudex.example"],
  );
});

test("extra domains turn trusted into custom and add to the service's own", () => {
  const added = userNetworkPolicy(trusted, {
    ...on,
    domains: [
      "api.example.com",
      "*.Cdn.Example.com",
      "not a domain",
      "localhost",
    ],
  });
  assert.equal(added.level, "custom");
  assert.deepEqual(added.customDomains, [
    "api.example.com",
    "*.cdn.example.com",
  ]);
  const custom: NetPolicy = {
    level: "custom",
    customDomains: ["own.example.org"],
  };
  assert.deepEqual(
    userNetworkPolicy(custom, { ...on, domains: ["api.example.com"] })
      .customDomains,
    ["own.example.org", "api.example.com"],
  );
});

test("All domains needs a service at full; packages only narrows a full one", () => {
  const full: NetPolicy = { level: "full" };
  assert.equal(
    userNetworkPolicy(full, { ...on, allowlist: "all" }).level,
    "full",
  );
  const narrowed = userNetworkPolicy(full, {
    ...on,
    domains: ["a.example.com"],
  });
  assert.equal(narrowed.level, "custom");
  assert.deepEqual(narrowed.customDomains, ["a.example.com"]);
  // A trusted service ignores "all": it stays at its own list.
  assert.deepEqual(
    userNetworkPolicy(trusted, { ...on, allowlist: "all" }),
    trusted,
  );
});

test("the settings schema takes domains, not addresses or paths", () => {
  const schema = preferenceFields.egressDomains!;
  assert.ok(schema.safeParse(["example.com", "*.example.com"]).success);
  for (const bad of [
    "localhost",
    "http://a.com",
    "a.com/x",
    "1.2.3.4",
    "*",
    "a b.com",
  ])
    assert.equal(schema.safeParse([bad]).success, false, bad);
  assert.equal(schema.safeParse(Array(51).fill("a.com")).success, false);
});

test("None allows only the domains the user added, without the package managers", () => {
  const only = userNetworkPolicy(trusted, {
    ...on,
    allowlist: "none",
    domains: ["api.example.com", "not a domain"],
    connectors: ["mcp.example.net"],
  });
  assert.equal(only.level, "custom");
  assert.deepEqual(only.trustedDomains, []);
  assert.deepEqual(only.customDomains, ["api.example.com", "mcp.example.net"]);
  assert.deepEqual(only.deniedHosts, ["claudex.example"]);
  // Egress off ignores the added domains: only the connectors stay.
  assert.deepEqual(
    userNetworkPolicy(trusted, {
      ...on,
      enabled: false,
      domains: ["api.example.com"],
      connectors: ["mcp.example.net"],
    }).customDomains,
    ["mcp.example.net"],
  );
});
