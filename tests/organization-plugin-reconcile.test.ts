import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { OrganizationPlugins } from "../electron/plugins/organization-plugins";
import type { OrganizationPluginGrant } from "../electron/plugins/organization-plugin-package";
import type { PluginRpc } from "../electron/plugins/plugins";
import { Sub2ApiError } from "../electron/sub2api/http";

test("automatic policy honors member preferences and revoked grants remove the managed installation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-policy-"));
  try {
    const marketplace = "12345678-1234-4234-8234-123456789abc";
    const name = "example";
    const id = "plugin_" + createHash("sha256").update(`organization-plugin:${marketplace}/${name}`).digest("hex").slice(0, 24);
    const zip = new JSZip();
    zip.file(".claude-plugin/plugin.json", JSON.stringify({ name, version: "1" }));
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const digest = createHash("sha256").update(archive).digest("hex");
    const grant: OrganizationPluginGrant = { id, organization_id: marketplace, marketplace_id: marketplace, name, display_name: name, description: "", version: "1", sha256: digest, installation_preference: "auto_install" };
    let authorized = true;
    let transient = false;
    let installed = false;
    let enabled = false;
    const calls: string[] = [];
    const packages = {
      catalog: async () => authorized ? [{ ...grant, marketplace_display_name: "Org", package_available: true }] : [],
      authorize: async () => {
        if (transient) throw new Sub2ApiError(503, "UNAVAILABLE", "Unavailable");
        if (!authorized) throw new Sub2ApiError(404, "CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND", "Not found");
        return grant;
      },
      archive: async () => archive,
    };
    const rpc: PluginRpc = { call: async (method, args) => {
      calls.push(method);
      if (method === "plugin/install") installed = true;
      if (method === "plugin/uninstall") installed = false;
      if (method === "config/batchWrite") {
        assert.ok(args && typeof args === "object" && "edits" in args && Array.isArray(args.edits));
        enabled = args.edits[0].value[`${name}@org-${marketplace}-${id.slice(7)}`].enabled;
      }
      if (method === "plugin/list") {
        assert.ok(args && typeof args === "object" && "cwds" in args && Array.isArray(args.cwds));
        return { marketplaces: [{ name: `org-${marketplace}-${id.slice(7)}`, path: path.join(args.cwds[0], ".agents/plugins/marketplace.json"), plugins: [{ id: `${name}@org-${marketplace}-${id.slice(7)}`, name, installed, enabled }] }] };
      }
      return {};
    } };
    const activation = { root, packages, rpc: async () => rpc, current: () => true };
    const plugins = new OrganizationPlugins();
    await plugins.reconcile(activation);
    assert.equal(installed, true);
    assert.equal(enabled, true);
    assert.equal(fs.readFileSync(path.join(root, "organization-plugins", id, "installed-digest"), "utf8"), digest);
    await plugins.reconcile(activation);
    assert.equal(calls.filter((call) => call === "plugin/install").length, 1);
    await plugins.setEnabled(id, false, activation);
    await plugins.reconcile(activation);
    assert.equal(enabled, false);
    await assert.rejects(plugins.remove(id, activation));
    grant.installation_preference = "required";
    await plugins.reconcile(activation);
    assert.equal(enabled, true);
    await assert.rejects(plugins.setEnabled(id, false, activation));
    authorized = false;
    transient = true;
    await assert.rejects(plugins.reconcile(activation));
    assert.equal(installed, true);
    transient = false;
    await plugins.reconcile(activation);
    assert.equal(installed, false);
    assert.equal(fs.existsSync(path.join(root, "organization-plugins", id, "installed-digest")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conversation runtime follows the account installation and withdraws disabled or revoked plugins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-peer-"));
  const accountRoot = path.join(root, "account");
  const peerRoot = path.join(root, "peer");
  fs.mkdirSync(accountRoot);
  fs.mkdirSync(peerRoot);
  try {
    const marketplace = "12345678-1234-4234-8234-123456789abc";
    const name = "example";
    const id = "plugin_" + createHash("sha256").update(`organization-plugin:${marketplace}/${name}`).digest("hex").slice(0, 24);
    const zip = new JSZip();
    zip.file(".claude-plugin/plugin.json", JSON.stringify({ name, version: "1" }));
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const grant: OrganizationPluginGrant = { id, organization_id: marketplace, marketplace_id: marketplace, name, display_name: name, description: "", version: "1", sha256: createHash("sha256").update(archive).digest("hex"), installation_preference: "available" };
    let authorized = true;
    const packages = {
      catalog: async () => authorized ? [{ ...grant, marketplace_display_name: "Org", package_available: true }] : [],
      authorize: async () => {
        if (!authorized) throw new Sub2ApiError(404, "CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND", "Not found");
        return grant;
      },
      archive: async () => archive,
    };
    function makeRpc() {
      let installed = false;
      let enabled = false;
      let installs = 0;
      const rpc: PluginRpc = { call: async (method, args) => {
        if (method === "plugin/install") { installed = true; installs++; }
        if (method === "plugin/uninstall") installed = false;
        if (method === "config/batchWrite") {
          assert.ok(args && typeof args === "object" && "edits" in args && Array.isArray(args.edits));
          enabled = args.edits[0].value[`${name}@org-${marketplace}-${id.slice(7)}`].enabled;
        }
        if (method === "plugin/list") {
          assert.ok(args && typeof args === "object" && "cwds" in args && Array.isArray(args.cwds));
          return { marketplaces: args.cwds.map((cwd: string) => ({ name: `org-${marketplace}-${id.slice(7)}`, path: path.join(cwd, ".agents/plugins/marketplace.json"), plugins: [{ id: `${name}@org-${marketplace}-${id.slice(7)}`, name, installed, enabled }] })) };
        }
        return {};
      } };
      return { rpc, get installed() { return installed; }, get installs() { return installs; } };
    }
    const primary = makeRpc();
    const peer = makeRpc();
    const account = { root: accountRoot, packages, rpc: async () => primary.rpc, current: () => true, sandboxReadable: true };
    const conversation = { root: peerRoot, packages, rpc: async () => peer.rpc, current: () => true, sandboxReadable: true };
    const plugins = new OrganizationPlugins();
    assert.equal(await plugins.syncForConversation(account, conversation), false);
    await plugins.setEnabled(id, true, account);
    assert.equal(await plugins.syncForConversation(account, conversation), true);
    assert.equal(peer.installed, true);
    const peerOwner = path.join(peerRoot, "organization-plugins", id);
    assert.equal(fs.statSync(path.join(peerOwner, grant.sha256)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(peerOwner, "installed-digest")).mode & 0o777, 0o600);
    const accountOwner = path.join(accountRoot, "organization-plugins", id);
    assert.equal(fs.statSync(path.join(accountOwner, grant.sha256)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(accountOwner, "installed-digest")).mode & 0o777, 0o600);
    assert.equal(await plugins.syncForConversation(account, conversation), false);
    assert.equal(peer.installs, 1);
    const approvedDigest = grant.sha256;
    grant.sha256 = "a".repeat(64);
    await assert.rejects(plugins.syncForConversation(account, conversation), /no longer approved/);
    grant.sha256 = approvedDigest;
    await plugins.setEnabled(id, false, account);
    assert.equal(await plugins.syncForConversation(account, conversation), true);
    assert.equal(peer.installed, false);
    assert.equal(fs.existsSync(peerOwner), false);
    await plugins.setEnabled(id, true, account);
    await plugins.syncForConversation(account, conversation);
    authorized = false;
    assert.equal(await plugins.syncForConversation(account, conversation), true);
    assert.equal(peer.installed, false);
    assert.equal(fs.existsSync(peerOwner), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
