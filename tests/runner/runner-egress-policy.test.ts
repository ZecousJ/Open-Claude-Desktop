// W-EGRESS: sandbox network levels and address denial (runner/src/net-policy.ts).
// Erasable TypeScript only, so plain Node can run this file too.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TRUSTED_DOMAINS,
  NetPolicyError,
  forbiddenAddress,
  ipToBigInt,
  normalizeHost,
  parseDomainPattern,
} from "../../runner/src/net-policy.ts";
import {
  compilePolicy,
  denyMessage,
  parseNetConfig,
  publicLookup,
  resolveAllowed,
} from "../../runner/src/net-policy-compile.ts";
import type { NetPolicy } from "../../runner/src/net-policy.ts";
import type { Resolver } from "../../runner/src/net-policy-compile.ts";

describe("addresses", () => {
  test("private, internal, metadata and reserved addresses are refused", () => {
    const cases: Array<[string, string]> = [
      ["10.1.2.3", "private"],
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["192.168.1.1", "private"],
      ["100.64.0.1", "private"],
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"],
      ["0.0.0.0", "reserved"],
      ["169.254.1.1", "link-local"],
      ["169.254.169.254", "metadata"],
      ["169.254.170.2", "metadata"],
      ["100.100.100.200", "metadata"],
      ["192.0.0.192", "metadata"],
      ["fd00:ec2::254", "metadata"],
      ["224.0.0.1", "multicast"],
      ["255.255.255.255", "reserved"],
      ["198.18.0.1", "reserved"],
      ["::", "reserved"],
      ["::1", "loopback"],
      ["fe80::1", "link-local"],
      ["fe80::1%eth0", "link-local"],
      ["fd12:3456::1", "private"],
      ["fc00::1", "private"],
      ["ff02::1", "multicast"],
      ["2001:db8::1", "reserved"],
      ["2001:0:4136:e378::1", "reserved"], // Teredo
      // IPv4 embedded in IPv6 is judged by the IPv4 address.
      ["::ffff:127.0.0.1", "loopback"],
      ["::ffff:7f00:1", "loopback"],
      ["::ffff:169.254.169.254", "metadata"],
      ["::127.0.0.1", "loopback"],
      ["64:ff9b::a00:1", "private"], // NAT64 of 10.0.0.1
      ["64:ff9b::a9fe:a9fe", "metadata"],
      ["2002:c0a8:101::1", "private"], // 6to4 of 192.168.1.1
      ["64:ff9b:1::1", "private"],
      ["not-an-address", "reserved"],
      ["1.2.3", "reserved"],
      ["01.2.3.4", "reserved"],
    ];
    for (const [address, reason] of cases)
      assert.equal(forbiddenAddress(address), reason, address);
  });

  test("ordinary public addresses pass", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.215.14",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700:4700::1111",
      "2a00:1450:4001::200e",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2002:808:808::1",
    ])
      assert.equal(forbiddenAddress(address), undefined, address);
  });

  test("parsing is strict", () => {
    assert.equal(ipToBigInt("1.2.3.4"), (0xffffn << 32n) | 0x01020304n);
    assert.equal(ipToBigInt("::ffff:1.2.3.4"), ipToBigInt("1.2.3.4"));
    assert.equal(ipToBigInt("[::1]"), 1n);
    assert.equal(
      ipToBigInt("1:2:3:4:5:6:1.2.3.4"),
      ipToBigInt("1:2:3:4:5:6:102:304"),
    );
    for (const bad of [
      "1.2.3.256",
      "0x7f.0.0.1",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "12345::",
      ":1::",
      "",
    ])
      assert.equal(ipToBigInt(bad), undefined, bad);
  });
});

describe("names", () => {
  test("hosts are normalized; address tricks are not hosts", () => {
    assert.equal(normalizeHost("GitHub.COM."), "github.com");
    assert.equal(normalizeHost("[::1]"), "::1");
    assert.equal(normalizeHost("1.1.1.1"), "1.1.1.1");
    for (const bad of [
      "2130706433",
      "0x7f.1",
      "127.1",
      "a..b",
      "-a.com",
      "a b.com",
      "é.com",
      "",
      "x".repeat(254),
    ])
      assert.equal(normalizeHost(bad), undefined, bad);
  });

  test("domain entries: plain matches subdomains, wildcard only subdomains", () => {
    assert.deepEqual(parseDomainPattern("Example.com"), {
      exact: "example.com",
      suffix: "example.com",
    });
    assert.deepEqual(parseDomainPattern("*.example.com"), {
      suffix: "example.com",
    });
    assert.throws(() => parseDomainPattern("com"), NetPolicyError);
    assert.throws(() => parseDomainPattern("*"), NetPolicyError);
    assert.throws(() => parseDomainPattern("*.com"), NetPolicyError);
    assert.throws(() => parseDomainPattern("*.1.2.3.4"), NetPolicyError);
    assert.throws(() => parseDomainPattern("exa mple.com"), NetPolicyError);
  });
});

describe("levels", () => {
  const policy = (p: Partial<NetPolicy> & { level: NetPolicy["level"] }) =>
    compilePolicy({
      trustedDomains: ["registry.npmjs.org", "github.com"],
      ...p,
    });

  test("none refuses everything", () => {
    const c = policy({ level: "none" });
    assert.deepEqual(c.checkHost("github.com", 443), {
      ok: false,
      reason: "network-off",
    });
  });

  test("trusted allows the listed domains on web ports only", () => {
    const c = policy({ level: "trusted" });
    assert.equal(c.checkHost("registry.npmjs.org", 443).ok, true);
    assert.equal(c.checkHost("codeload.github.com", 443).ok, true);
    assert.equal(c.checkHost("GITHUB.com.", 80).ok, true);
    assert.deepEqual(c.checkHost("evil.com", 443), {
      ok: false,
      reason: "not-allowed",
    });
    assert.deepEqual(c.checkHost("github.com.evil.com", 443), {
      ok: false,
      reason: "not-allowed",
    });
    assert.deepEqual(c.checkHost("notgithub.com", 443), {
      ok: false,
      reason: "not-allowed",
    });
    assert.deepEqual(c.checkHost("github.com", 22), {
      ok: false,
      reason: "port",
    });
    assert.deepEqual(c.checkHost("1.1.1.1", 443), {
      ok: false,
      reason: "not-allowed",
    });
  });

  test("custom adds the environment's domains; trusted ignores them", () => {
    const custom = policy({
      level: "custom",
      customDomains: ["api.example.org"],
    });
    assert.equal(custom.checkHost("api.example.org", 443).ok, true);
    assert.equal(custom.checkHost("github.com", 443).ok, true);
    const trusted = policy({
      level: "trusted",
      customDomains: ["api.example.org"],
    });
    assert.equal(trusted.checkHost("api.example.org", 443).ok, false);
  });

  test("full allows any public name and port except mail", () => {
    const c = policy({ level: "full" });
    assert.equal(c.checkHost("anything.example", 443).ok, true);
    assert.equal(c.checkHost("anything.example", 8443).ok, true);
    assert.equal(c.checkHost("8.8.8.8", 53).ok, true);
    assert.deepEqual(c.checkHost("smtp.example.com", 25), {
      ok: false,
      reason: "port",
    });
    assert.deepEqual(c.checkHost("x.example.com", 0), {
      ok: false,
      reason: "port",
    });
    assert.deepEqual(c.checkHost("x.example.com", 70000), {
      ok: false,
      reason: "port",
    });
  });

  test("internal names, denied hosts and literal private addresses are refused at every level", () => {
    const c = policy({
      level: "full",
      deniedHosts: ["claudex.example.com"],
      deniedAddresses: ["203.0.113.0/24", "198.51.100.7", "2a01:4f8::/32"],
    });
    for (const [host, reason] of [
      ["localhost", "internal-name"],
      ["db.localhost", "internal-name"],
      ["metadata.google.internal", "internal-name"],
      ["printer.local", "internal-name"],
      ["router.home.arpa", "internal-name"],
      ["claudex.example.com", "denied-host"],
      ["api.claudex.example.com", "denied-host"],
      ["127.0.0.1", "loopback"],
      ["[::1]", "loopback"],
      ["169.254.169.254", "metadata"],
      ["10.0.0.8", "private"],
      ["2a01:4f8::1", "denied-address"],
      ["bad host", "bad-host"],
    ] as const)
      assert.deepEqual(c.checkHost(host, 443), { ok: false, reason }, host);
    assert.deepEqual(c.checkAddress("198.51.100.7"), {
      ok: false,
      reason: "reserved",
    });
    assert.deepEqual(c.checkAddress("::ffff:203.0.113.9"), {
      ok: false,
      reason: "reserved",
    });
  });

  test("the runner's own addresses are refused", () => {
    const c = compilePolicy(
      { level: "full", deniedAddresses: ["5.6.7.0/24"] },
      ["93.184.215.14", "2001:4860::8888"],
    );
    assert.deepEqual(c.checkAddress("93.184.215.14"), {
      ok: false,
      reason: "own-address",
    });
    assert.deepEqual(c.checkAddress("::ffff:93.184.215.14"), {
      ok: false,
      reason: "own-address",
    });
    assert.deepEqual(c.checkAddress("2001:4860::8888"), {
      ok: false,
      reason: "own-address",
    });
    assert.deepEqual(c.checkAddress("5.6.7.8"), {
      ok: false,
      reason: "denied-address",
    });
    assert.deepEqual(c.checkAddress("93.184.215.15"), { ok: true });
  });

  test("explicit ports replace the level's defaults", () => {
    const c = policy({ level: "trusted", ports: [443, 9418] });
    assert.equal(c.checkHost("github.com", 9418).ok, true);
    assert.equal(c.checkHost("github.com", 80).ok, false);
    assert.throws(
      () => compilePolicy({ level: "full", ports: [0] }),
      NetPolicyError,
    );
  });

  test("defaults: the trusted list and the 5 GB allowance", () => {
    const c = compilePolicy({ level: "trusted" });
    assert.equal(c.maxBytes, DEFAULT_MAX_BYTES);
    assert.equal(DEFAULT_MAX_BYTES, 5_000_000_000);
    for (const d of DEFAULT_TRUSTED_DOMAINS)
      assert.equal(c.checkHost(d, 443).ok, true, d);
    assert.throws(
      () => compilePolicy({ level: "open" as never }),
      NetPolicyError,
    );
    assert.throws(
      () => compilePolicy({ level: "full", maxBytes: 0 }),
      NetPolicyError,
    );
    assert.throws(
      () => compilePolicy({ level: "custom", customDomains: ["*"] }),
      NetPolicyError,
    );
  });

  test("refusal messages are plain English", () => {
    assert.equal(
      denyMessage("network-off"),
      "Network access is off for this environment.",
    );
    assert.match(
      denyMessage("metadata", "169.254.169.254", 80),
      /^169\.254\.169\.254:80 is a private or internal address/,
    );
    assert.match(
      denyMessage("not-allowed", "evil.com", 443),
      /evil\.com:443 is not on this environment's list/,
    );
  });
});

describe("resolution", () => {
  const full = compilePolicy({ level: "full" });
  const fixed =
    (answers: Record<string, string[]>): Resolver =>
    async (host) => {
      const a = answers[host];
      if (!a)
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return a;
    };

  test("a name with any private answer is refused as a whole", async () => {
    const r = fixed({
      "ok.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
      "mixed.example": ["93.184.215.14", "10.0.0.5"],
      "meta.example": ["169.254.169.254"],
      "mapped.example": ["::ffff:127.0.0.1"],
      "empty.example": [],
    });
    assert.deepEqual(await resolveAllowed(full, "ok.example", r), {
      ok: true,
      addresses: ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    });
    assert.deepEqual(await resolveAllowed(full, "mixed.example", r), {
      ok: false,
      reason: "private",
    });
    assert.deepEqual(await resolveAllowed(full, "meta.example", r), {
      ok: false,
      reason: "metadata",
    });
    assert.deepEqual(await resolveAllowed(full, "mapped.example", r), {
      ok: false,
      reason: "loopback",
    });
    assert.deepEqual(await resolveAllowed(full, "empty.example", r), {
      ok: false,
      reason: "unresolved",
    });
    assert.deepEqual(await resolveAllowed(full, "missing.example", r), {
      ok: false,
      reason: "unresolved",
    });
    assert.deepEqual(await resolveAllowed(full, "8.8.8.8", r), {
      ok: true,
      addresses: ["8.8.8.8"],
    });
  });

  test("publicLookup answers only with checked public addresses", async () => {
    const lookup = publicLookup(
      full,
      fixed({
        "ok.example": ["93.184.215.14", "2606:4700::1"],
        "bad.example": ["192.168.0.2"],
      }),
    );
    const one = await new Promise<unknown[]>((resolve) =>
      lookup("ok.example", {}, (...args) => resolve(args)),
    );
    assert.deepEqual(one, [null, "93.184.215.14", 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      lookup("ok.example", { all: true }, (...args) => resolve(args)),
    );
    assert.deepEqual(all[1], [
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
    const bad = await new Promise<unknown[]>((resolve) =>
      lookup("bad.example", {}, (...args) => resolve(args)),
    );
    assert.equal((bad[0] as NodeJS.ErrnoException).code, "ECLAUDEXEGRESS");
  });
});

describe("runner configuration", () => {
  test("defaults to trusted and denies the service by name", () => {
    const { policy, warnings } = parseNetConfig({}, "namespaces", [
      "claudex.example.com",
      "127.0.0.1",
    ]);
    assert.equal(policy.level, "trusted");
    assert.deepEqual(warnings, []);
    assert.deepEqual(policy.deniedHosts, ["claudex.example.com"]);
    assert.deepEqual(policy.deniedAddresses, ["127.0.0.1"]);
    const c = compilePolicy(policy);
    assert.equal(c.checkHost("claudex.example.com", 443).ok, false);
  });

  test("bwrap isolation caps the level at trusted", () => {
    const capped = parseNetConfig(
      { CLAUDEX_RUNNER_NETWORK: "full" },
      "namespaces",
    );
    assert.equal(capped.policy.level, "trusted");
    assert.match(
      capped.warnings[0]!,
      /full is not available with namespaces isolation; using trusted/,
    );
    assert.equal(
      parseNetConfig({ CLAUDEX_RUNNER_NETWORK: "custom" }, "namespaces").policy
        .level,
      "trusted",
    );
    assert.equal(
      parseNetConfig({ CLAUDEX_RUNNER_NETWORK: "full" }, "gvisor").policy.level,
      "full",
    );
    assert.equal(
      parseNetConfig({ CLAUDEX_RUNNER_NETWORK: "none" }, "namespaces").policy
        .level,
      "none",
    );
  });

  test("lists, deny entries, ports and allowance", () => {
    const { policy } = parseNetConfig(
      {
        CLAUDEX_RUNNER_NETWORK: "custom",
        CLAUDEX_RUNNER_TRUSTED_DOMAINS: "github.com, pypi.org",
        CLAUDEX_RUNNER_CUSTOM_DOMAINS: "api.example.org",
        CLAUDEX_RUNNER_EGRESS_DENY:
          "203.0.113.4, 2a01:4f8::/32, dc6.example.net",
        CLAUDEX_RUNNER_EGRESS_PORTS: "443",
        CLAUDEX_RUNNER_EGRESS_MAX_GB: "1.5",
      },
      "gvisor",
    );
    assert.deepEqual(policy, {
      level: "custom",
      trustedDomains: ["github.com", "pypi.org"],
      customDomains: ["api.example.org"],
      deniedHosts: ["dc6.example.net"],
      deniedAddresses: ["203.0.113.4", "2a01:4f8::/32"],
      ports: [443],
      maxBytes: 1_500_000_000,
    });
  });

  test("mistakes are refused", () => {
    for (const env of [
      { CLAUDEX_RUNNER_NETWORK: "open" },
      { CLAUDEX_RUNNER_EGRESS_DENY: "10.0.0.0/40" },
      { CLAUDEX_RUNNER_EGRESS_DENY: "exa$mple.com" },
      { CLAUDEX_RUNNER_TRUSTED_DOMAINS: "*" },
      { CLAUDEX_RUNNER_EGRESS_PORTS: "https" },
      { CLAUDEX_RUNNER_EGRESS_MAX_GB: "0" },
    ])
      assert.throws(
        () => parseNetConfig(env, "gvisor"),
        NetPolicyError,
        JSON.stringify(env),
      );
  });
});

describe("fake-IP ranges (a host proxy answering DNS with 198.18.x.x)", () => {
  const fake: Resolver = async (host) =>
    host === "github.com" ? ["198.18.0.11"] : ["198.18.0.99"];
  test("an allowed name resolving into the range passes below full", async () => {
    const trusted = compilePolicy({
      level: "trusted",
      fakeIpRanges: ["198.18.0.0/15"],
    });
    assert.deepEqual(await resolveAllowed(trusted, "github.com", fake), {
      ok: true,
      addresses: ["198.18.0.11"],
    });
    assert.deepEqual(trusted.checkResolved("198.18.0.11"), { ok: true });
  });
  test("the range stays refused without the setting, for IP literals and at full", async () => {
    const plain = compilePolicy({ level: "trusted" });
    assert.equal((await resolveAllowed(plain, "github.com", fake)).ok, false);
    const trusted = compilePolicy({
      level: "trusted",
      fakeIpRanges: ["198.18.0.0/15"],
    });
    assert.equal(trusted.checkHost("198.18.0.11", 443).ok, false);
    assert.equal(trusted.checkAddress("198.18.0.11").ok, false);
    const full = compilePolicy({
      level: "full",
      fakeIpRanges: ["198.18.0.0/15"],
    });
    assert.equal(
      (await resolveAllowed(full, "anything.example", fake)).ok,
      false,
    );
  });
  test("names outside the allowlist are still refused before resolving", () => {
    const trusted = compilePolicy({
      level: "trusted",
      fakeIpRanges: ["198.18.0.0/15"],
    });
    assert.equal(trusted.checkHost("www.google.com", 443).ok, false);
  });
  test("the env setting is read and validated", () => {
    const { policy } = parseNetConfig(
      { CLAUDEX_RUNNER_FAKE_IP_RANGES: "198.18.0.0/15" } as NodeJS.ProcessEnv,
      "strong" as never,
    );
    assert.deepEqual(policy.fakeIpRanges, ["198.18.0.0/15"]);
    assert.throws(() =>
      parseNetConfig(
        { CLAUDEX_RUNNER_FAKE_IP_RANGES: "nope" } as NodeJS.ProcessEnv,
        "strong" as never,
      ),
    );
  });
});
