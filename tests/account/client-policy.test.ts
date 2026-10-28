import test from "node:test";
import assert from "node:assert/strict";
import {
  browserHostBlocked,
  browserPolicyOf,
  computerUsePolicyOf,
  lockedPolicy,
  modeAllowed,
  offlinePolicy,
  openPolicy,
  pendingPolicy,
  researchPolicyOf,
  settingsWithinPolicy,
  sshRemoteAllowed,
  type ClientPolicy,
} from "../../shared/client-policy";
import {
  allowedMcpServers,
  clientUpdate,
  compareVersions,
  connectorAllowed,
  releaseUpdate,
  urlUnderPrefix,
} from "../../shared/client-policy-rules";
import { cachedPolicyInForce } from "../../electron/account/client-policy";
import { parsePolicy } from "../../shared/claudex-contract";
import { catalogForModels } from "../../shared/model-catalog-api";
import type { ModelCatalogItem } from "../../shared/model-catalog-api";
import {
  policyFixtures,
  servicePolicyWire as wirePolicy,
} from "../../scripts/preview/fixtures/policy-data";

test("versions compare by semantic-version precedence", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.2.0",
    "1.10.0",
  ];
  for (let i = 0; i < ordered.length; i++)
    for (let j = 0; j < ordered.length; j++)
      assert.equal(
        compareVersions(ordered[i], ordered[j]),
        Math.sign(i - j),
        `${ordered[i]} vs ${ordered[j]}`,
      );
  // Build metadata is ignored; missing parts are zero.
  assert.equal(compareVersions("1.4.0+build.7", "1.4.0"), 0);
  assert.equal(compareVersions("1.4.0+a", "1.4.0+b"), 0);
  assert.equal(compareVersions("1.4", "1.4.0"), 0);
  assert.equal(compareVersions("1.4.0-rc.1+x", "1.4.0"), -1);
});

test("the service's release state and enforcement decide the update", () => {
  const release = {
    state: "required",
    enforced: false,
    latestVersion: "1.4.0",
    minimumVersion: "1.5.0",
    downloadUrl: "https://claudex.example.com/download",
  };
  assert.deepEqual(releaseUpdate("1.2.0", release), {
    state: "required",
    currentVersion: "1.2.0",
    latestVersion: "1.5.0",
    downloadUrl: "https://claudex.example.com/download",
    enforced: false,
  });
  assert.equal(
    releaseUpdate("1.2.0", { ...release, state: "current" }),
    undefined,
  );
  assert.equal(
    releaseUpdate("1.2.0", { ...release, state: "available", enforced: true })
      ?.state,
    "available",
  );
  // Without the service's comparison, this build compares (pre-release first).
  const unknown = {
    state: "unknown",
    enforced: true,
    latestVersion: "1.4.0",
    minimumVersion: "1.4.0",
    downloadUrl: null,
  };
  assert.deepEqual(releaseUpdate("1.4.0-beta.1", unknown), {
    state: "required",
    currentVersion: "1.4.0-beta.1",
    latestVersion: "1.4.0",
    enforced: true,
  });
  assert.equal(releaseUpdate("1.4.0+local", unknown), undefined);
  assert.equal(
    clientUpdate("1.4.0-beta.1", { latestVersion: "1.4.0" })?.state,
    "available",
  );
});

const rules = (connectors: ClientPolicy["connectors"]) => ({ connectors });

test("a connector with an allowed name but another program is blocked", () => {
  const policy = rules([
    { name: "files", command: "npx", args: ["-y", "@acme/files-mcp"] },
  ]);
  const allowed = { command: "npx", args: ["-y", "@acme/files-mcp"] };
  assert.equal(connectorAllowed(policy, "files", allowed), true);
  // Same name, other program; same program, other package; extra arguments.
  assert.equal(
    connectorAllowed(policy, "files", { command: "/tmp/evil", args: [] }),
    false,
  );
  assert.equal(
    connectorAllowed(policy, "files", {
      command: "npx",
      args: ["-y", "evil-mcp"],
    }),
    false,
  );
  assert.equal(
    connectorAllowed(policy, "files", {
      command: "npx",
      args: ["-y", "@acme/files-mcp", "--root", "/"],
    }),
    false,
  );
  // A program rule never allows a remote server of that name.
  assert.equal(
    connectorAllowed(policy, "files", { url: "https://files.example.com" }),
    false,
  );
  // A program rule without arguments allows the program run without any.
  const bare = rules([{ name: "git", command: "git-mcp" }]);
  assert.equal(connectorAllowed(bare, "git", { command: "git-mcp" }), true);
  assert.equal(
    connectorAllowed(bare, "git", { command: "git-mcp", args: ["x"] }),
    false,
  );
  // A name-only rule allows the server by name; an unlisted name never runs.
  const byName = rules([{ name: "linear" }]);
  assert.equal(connectorAllowed(byName, "linear", { command: "any" }), true);
  assert.equal(connectorAllowed(byName, "other", { command: "any" }), false);
  assert.deepEqual(
    Object.keys(
      allowedMcpServers(
        { files: allowed, evil: allowed, linear: { command: "x" } },
        rules([...policy.connectors!, ...byName.connectors!]),
      ),
    ),
    ["files", "linear"],
  );
  // No allowlist: everything configured may run.
  assert.equal(connectorAllowed(rules(null), "anything", {}), true);
});

test("the service's connector rules keep programs and arguments exact and prefixes on a path boundary", () => {
  const wire = parsePolicy({
    ...wirePolicy,
    connectors: [
      "linear",
      { name: "github", url_prefix: "https://api.githubcopilot.com/mcp" },
      { name: "files", command: "npx", args: ["-y", "@acme/files-mcp"] },
      { name: "plain", url_prefix: "http://insecure.example.com" },
    ],
  });
  assert.deepEqual(wire.connectors, [
    { name: "linear" },
    { name: "github", urlPrefix: "https://api.githubcopilot.com/mcp" },
    { name: "files", command: "npx", args: ["-y", "@acme/files-mcp"] },
  ]);
  const github = (url: string) =>
    connectorAllowed(wire, "github", { url, type: "http" });
  assert.equal(github("https://api.githubcopilot.com/mcp"), true);
  assert.equal(github("https://api.githubcopilot.com/mcp/"), true);
  assert.equal(github("https://API.githubcopilot.com:443/mcp/x?y=1"), true);
  assert.equal(github("https://api.githubcopilot.com/mcpx"), false);
  assert.equal(github("https://api.githubcopilot.com/other"), false);
  assert.equal(github("http://api.githubcopilot.com/mcp"), false);
  assert.equal(github("https://api.githubcopilot.com.evil.com/mcp"), false);
  assert.equal(github("https://api.githubcopilot.com@evil.com/mcp"), false);
  assert.equal(github("https://user:pw@api.githubcopilot.com/mcp"), false);
  assert.equal(github("not a url"), false);
  assert.equal(
    connectorAllowed(wire, "github", {
      command: "npx",
      url: "https://api.githubcopilot.com/mcp",
    }),
    false,
  );
  assert.equal(
    connectorAllowed(wire, "plain", { url: "http://insecure.example.com" }),
    false,
  );
  assert.equal(
    urlUnderPrefix("https://a.example.com/x", "https://a.example.com/"),
    true,
  );
  assert.equal(
    urlUnderPrefix("https://a.example.com/x", "https://a.example.com/x?q"),
    false,
  );
});

test("offline without a cached policy only MCP editing is held back; Bypass stays the user's", () => {
  const policy = offlinePolicy({
    mcpServers: { docs: { command: "docs-mcp" } },
  });
  assert.equal(policy.localMcpEditing, false);
  assert.deepEqual(policy.permissionModes, openPolicy.permissionModes);
  assert.equal(modeAllowed(policy, "bypass"), true);
  const settings = {
    codeSandbox: "danger-full-access" as const,
    codePlanMode: false,
    autoAcceptEdits: false,
    bypassFolders: [],
    allowBypassPermissions: true,
  };
  assert.equal(settingsWithinPolicy(settings, policy), undefined);
  // Even a policy allowing only Plan leaves Bypass alone.
  assert.equal(
    settingsWithinPolicy(settings, { permissionModes: ["plan"] }),
    undefined,
  );
});

const item = (
  id: string,
  sort: number,
  extra: Partial<ModelCatalogItem> = {},
): ModelCatalogItem => ({
  id,
  displayName: id.toUpperCase(),
  description: "",
  badges: [],
  sort,
  hidden: false,
  isDefault: false,
  usageHint: "",
  ...extra,
});

test("the catalog meets the gateway's models and picks the default", () => {
  const catalog = {
    defaultModel: "gpt-5.5",
    items: [
      item("gpt-5.5-mini", 20),
      item("gpt-5.5", 10, { contextWindow: 400000 }),
      item("gpt-4o", 5, { hidden: true }),
      item("retired", 1),
    ],
  };
  const met = catalogForModels(catalog, [
    "gpt-4o",
    "gpt-5.5-mini",
    "gpt-5.5",
    "extra-model",
    "gpt-5.5",
  ]);
  // Catalog order, entries the gateway lacks dropped, and models the
  // catalog leaves out (the administrator hid them) dropped too.
  assert.deepEqual(met.models, ["gpt-4o", "gpt-5.5", "gpt-5.5-mini"]);
  assert.equal(met.defaultModel, "gpt-5.5");
  assert.equal(met.catalog?.defaultModel, "gpt-5.5");
  const byId = new Map(met.catalog!.items.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("gpt-4o")?.hidden, true);
  assert.equal(byId.get("gpt-5.5")?.isDefault, true);
  assert.equal(byId.get("gpt-5.5")?.contextWindow, 400000);
  assert.equal(byId.has("extra-model"), false);
  assert.equal(byId.has("retired"), false);
  // The default is not listed: the first visible entry in catalog order.
  assert.equal(
    catalogForModels({ ...catalog, defaultModel: "retired" }, [
      "gpt-4o",
      "gpt-5.5-mini",
    ]).defaultModel,
    "gpt-5.5-mini",
  );
  // Only unknown models: the gateway's list as it is, its first the default.
  const unknown = catalogForModels(catalog, ["x", "y"]);
  assert.equal(unknown.defaultModel, "x");
  assert.deepEqual(unknown.models, ["x", "y"]);
  // No catalog (older service): the gateway's list as it is.
  assert.deepEqual(catalogForModels(null, ["b", "a", "b"]), {
    catalog: null,
    models: ["b", "a"],
    defaultModel: "b",
  });
});

test("search capabilities pass through the gateway intersection; fast is never set", () => {
  const met = catalogForModels(
    {
      defaultModel: null,
      items: [
        item("grok-4", 1, { webSearch: "native", xSearch: true }),
        item("kimi", 2, { webSearch: "none", xSearch: false }),
      ],
    },
    ["grok-4", "kimi", "unlisted"],
  );
  const byId = new Map(met.catalog!.items.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("grok-4")?.webSearch, "native");
  assert.equal(byId.get("grok-4")?.xSearch, true);
  assert.equal(byId.get("kimi")?.webSearch, "none");
  // A model the catalog does not list: the service said nothing about it.
  assert.equal(byId.get("unlisted")?.webSearch, undefined);
  for (const entry of met.catalog!.items) assert.equal("fast" in entry, false);
});

test("round-2 policy presets: local open, pending and offline careful, locked closed", () => {
  // A local account: everything, computer use included (no service to ask).
  assert.equal(openPolicy.computerUse?.enabled, true);
  assert.equal(openPolicy.memory?.enabled, true);
  assert.equal(
    openPolicy.memory?.defaultOn,
    false,
    "memory switches start off",
  );
  assert.equal(openPolicy.research?.maxSearchesPerTurn, 30);
  assert.equal(openPolicy.sshRemote, true);
  assert.equal(openPolicy.codexRuntimeMirror, null);
  // Before the service answers, and offline without a cache: computer use
  // waits; SSH, the browser and memory stay usable, no mirror.
  for (const policy of [pendingPolicy, offlinePolicy({ mcpServers: {} })]) {
    assert.equal(policy.computerUse?.enabled, false);
    assert.equal(policy.sshRemote, true);
    assert.equal(policy.browser?.enabled, true);
    assert.equal(policy.memory?.enabled, true);
    assert.equal(policy.codexRuntimeMirror, null);
  }
  // A policy file that cannot be read: nothing optional runs, except the
  // browser, which runs on this computer (design R8 5.2).
  assert.equal(lockedPolicy.computerUse?.enabled, false);
  assert.equal(lockedPolicy.memory?.enabled, false);
  assert.equal(lockedPolicy.research?.enabled, false);
  assert.equal(lockedPolicy.sshRemote, false);
  assert.equal(lockedPolicy.browser?.enabled, true);
  // None of them names Bypass permissions.
  for (const policy of [openPolicy, pendingPolicy, lockedPolicy])
    assert.equal(
      JSON.stringify(policy).toLowerCase().includes("bypass"),
      false,
    );
});

test("round-2 fields an older service does not send read on their own terms", () => {
  const older: ClientPolicy = {
    ...openPolicy,
    memory: undefined,
    research: undefined,
    browser: undefined,
    sshRemote: undefined,
    codexRuntimeMirror: undefined,
    computerUse: undefined,
  };
  // Research follows web search; the browser and SSH are allowed; computer
  // use stays off.
  assert.deepEqual(researchPolicyOf(older), {
    enabled: true,
    xSearch: true,
    maxSearchesPerTurn: 30,
  });
  assert.deepEqual(researchPolicyOf({ ...older, webSearch: false }), {
    enabled: false,
    xSearch: false,
    maxSearchesPerTurn: 30,
  });
  assert.equal(browserPolicyOf(older).enabled, true);
  assert.equal(sshRemoteAllowed(older), true);
  assert.equal(sshRemoteAllowed({ sshRemote: false }), false);
  assert.equal(computerUsePolicyOf(older).enabled, false);
  // Web search off wins over a research block that says otherwise.
  assert.equal(
    researchPolicyOf({
      webSearch: false,
      research: { enabled: true, xSearch: true, maxSearchesPerTurn: 9 },
    }).enabled,
    false,
  );
});

test("blocked browser domains cover their subdomains, never lookalikes", () => {
  const policy = {
    browser: {
      ...openPolicy.browser!,
      blockedDomains: ["example.com", "*.bank.test"],
    },
  };
  assert.equal(browserHostBlocked(policy, "example.com"), true);
  assert.equal(browserHostBlocked(policy, "Mail.Example.COM."), true);
  assert.equal(browserHostBlocked(policy, "notexample.com"), false);
  assert.equal(browserHostBlocked(policy, "example.com.evil.test"), false);
  assert.equal(browserHostBlocked(policy, "bank.test"), true);
  assert.equal(browserHostBlocked(policy, "www.bank.test"), true);
  assert.equal(browserHostBlocked({}, "example.com"), false);
});

test("a cached policy keeps computer use waiting until the service answers", () => {
  const allowed: ClientPolicy = {
    ...openPolicy,
    computerUse: {
      enabled: true,
      allowFullControl: true,
      deniedApps: ["cmd.exe"],
      maxActionsPerTurn: 20,
    },
  };
  assert.deepEqual(cachedPolicyInForce(allowed).computerUse, {
    ...allowed.computerUse,
    enabled: false,
  });
  assert.equal(cachedPolicyInForce(pendingPolicy), pendingPolicy);
});

test("the fixture's service policy is what the client makes of the wire sample", () => {
  const { groupId, ...parsed } = parsePolicy(wirePolicy);
  assert.equal(groupId, 4);
  assert.deepEqual(parsed, policyFixtures.service);
  assert.equal(policyFixtures.offline.localMcpEditing, false);
  assert.equal(modeAllowed(policyFixtures.offline, "bypass"), true);
});

test("service Developer Mode policy is preserved, with older services allowed by default", () => {
  assert.equal(
    parsePolicy({ ...wirePolicy, developer_mode_enabled: false })
      .developerModeEnabled,
    false,
  );
  assert.equal(parsePolicy(wirePolicy).developerModeEnabled, true);
});

test("service managed-device extension flags retain independent values", () => {
  const policy = parsePolicy({
    ...wirePolicy,
    desktop_extensions_enabled: false,
    developer_mcp_enabled: true,
  });
  assert.equal(policy.desktopExtensionsEnabled, false);
  assert.equal(policy.developerMcpEnabled, true);
  assert.equal(parsePolicy(wirePolicy).desktopExtensionsEnabled, undefined);
});
